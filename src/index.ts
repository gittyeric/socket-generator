import { Socket as ServerSocket } from "socket.io";
import { Socket as ClientSocket } from 'socket.io-client';

const uniqueNameSet = new Set<string>()

/**
 * Creates an instance of an async generator that can be iterated to stream YIELDs from
 * the parent Contract's endpoint, ending with a RETURN value when done
 */
export type ClientFn<PARAMS extends unknown[], YIELD, RETURN> = (
  ...req: PARAMS
) => AsyncGenerator<YIELD, RETURN, undefined>

export type Endpoint = {
  bindClient: (socket: ServerSocket | ClientSocket) => void
}

/**
 * An instantiated Contract is a factory pattern than can then be used to either create the ClientFn (after
 * binding a client Socket.io socket) or an Endpoint (after binding both a server Socket.io socket and
 * the contract's responseGenerator implementation)
 */
export type Contract<PARAMS extends unknown[], YIELD, RETURN> = {
  newClient: (socket: ClientSocket<object, object>, timeoutMs?: number) => ClientFn<PARAMS, YIELD, RETURN>,
  newEndpoint: (
    responseGenerator: (...req: PARAMS) => AsyncGenerator<YIELD, RETURN, undefined> | Promise<RETURN>,
    logger?: (msg: string) => void) => Endpoint
}

/**
 * Creates a new Contract that creates a shared type agreement between Socket.io client and endpoints.
 * Because Socket.io is bidirectional, front-ends may be endpoints and servers may be clients too! A client
 * initializes a request by sending PARAMS and the endpoint responds with a stream of YIELDs ending in a RETURN.
 * @param uniqueName A unique name for this Socket.io client / endpoint contract
 * @returns A Contract instance that either client or endpoint can further instantiate with more context
 */
export function newContract<PARAMS extends unknown[], YIELD, RETURN>(uniqueName: string) {
  if (uniqueNameSet.has(uniqueName)) {
    throw new Error(`A socket-generator Contract named ${uniqueName} already exists!`)
  }
  uniqueNameSet.add(uniqueName)
  const responseTopic = `_res_${uniqueName}`
  const requestTopic = `_req_${uniqueName}`
  function newClient(
    socket: ClientSocket | ServerSocket,
    timeoutMs: number = Number.POSITIVE_INFINITY,
  ): ClientFn<PARAMS, YIELD, RETURN> {
    let reqId = BigInt(1)

    return async function* newClientRequest(...req: PARAMS): AsyncGenerator<YIELD, RETURN, undefined> {
      // Reserve a new queue
      const curReqId = (reqId++).toString(36)
      const queue = new BlockingQueue<UndefinedWrapper<YIELD, RETURN> | YieldWrapper<YIELD> | ReturnWrapper<RETURN> | ErrorWrapper>()

      // Setup timeout
      let timeoutRef: ReturnType<typeof setTimeout> = setTimeout(() => { }, 0)
      const pendingTimeout =
        timeoutMs < Number.MAX_SAFE_INTEGER
          ? new Promise<Error>((res) => {
            timeoutRef = setTimeout(() => {
              res(new Error(`Request timed out for ${uniqueName}`))
            }, timeoutMs)
          })
          : new Promise<Error>(() => { })

      let rejectWithDisconnect: undefined | ((err: NetworkError) => void) = undefined
      const disconnect = new Promise<NetworkError>((res) => {
        rejectWithDisconnect = res
      })
      const disconnectHandler = () => rejectWithDisconnect!(new NetworkError('Network disconnected', 'network disconnect'))
      socket.on('disconnect', disconnectHandler)

      // Start listening for yields that match request ID
      const responseHandler = (chunk: UndefinedWrapper<YIELD, RETURN> | ReturnWrapper<RETURN> | YieldWrapper<YIELD> | ErrorWrapper) => {
        const unwrapped = unwrap(chunk)
        const reqId = Array.isArray(unwrapped) ? unwrapped[0] : unwrapped.i
        if (reqId === curReqId) {
          queue.enqueue(unwrapped)
        }
      }
      socket.on(responseTopic, responseHandler)

      function cleanup() {
        socket.off(responseTopic, responseHandler)
        socket.off('disconnect', disconnectHandler)
        clearTimeout((timeoutRef as unknown) as ReturnType<typeof setTimeout>)
      }

      // Emit the request message
      socket.emit(requestTopic, { id: curReqId, req } as RequestWrapper<PARAMS>)

      // Wait till queue shows a Result wrapper
      while (true) {
        const pendingChunk = queue.dequeue()
        // Allow the timeout or disconnect to potentially win the race and throw
        const winner = await Promise.race([pendingChunk, pendingTimeout, disconnect])
        if (isNetworkError(winner)) {
          cleanup()
          throw winner
        }
        if (isError(winner)) {
          cleanup()
          throw winner
        }
        if (isErrorWrapper(winner)) {
          cleanup()
          throw new Error(winner.err)
        }
        const unwrappedWinner = unwrap(winner)
        if (isReturnWrapper(unwrappedWinner)) {
          cleanup()
          return unwrappedWinner.r as Awaited<RETURN>
        } else {
          yield unwrappedWinner[1] as YIELD
        }
      }
    } as ClientFn<PARAMS, YIELD, RETURN>
  }

  /**
   * Creates a new streaming endpoint endpoint specific to a particular client socket.  Call this once for each contract / Socket.io client pair.
   * @param socket The socket received from a Socket.io endpoint `on.('connection')` callback
   * @param responseGenerator The streaming async generator or async function that generates a response to the client
   * @param logger An option logger to log client connection information
   */
  function newEndpoint(
    // Can be a plain async function if YIELD type is never, otherwise must be an async generator function
    responseGenerator: (...req: PARAMS) => AsyncGenerator<YIELD, RETURN, undefined> | Promise<RETURN>,
    logger?: (msg: string) => void,
  ) {
    const log = logger || NOOP_LOGGER
    return {
      bindClient: (socket: ServerSocket | ClientSocket) => {
        log(`Opening endpoint ${uniqueName} for ${getSocketId(socket)}`)
        const requestHandler = async (request: RequestWrapper<PARAMS>) => {
          const gen = responseGenerator(...request.req)
          const isGenerator: boolean = isIterResult(gen)
          while (true) {
            try {
              const next = isGenerator ?
                await (gen as AsyncGenerator<YIELD, RETURN, undefined>).next() :
                { done: true, value: (await gen) as RETURN } as const
              if (socket.disconnected) {
                log(`Terminating in-flight response early, ${getSocketId(socket)} disconnected`)
                return
              }
              if (next.done) {
                const returnWrapper: ReturnWrapper<RETURN> = {
                  i: request.id,
                  r: next.value,
                }
                socket.emit(responseTopic, wrapUndefinedReturn(returnWrapper))
                return
              }
              const yieldWrapper: YieldWrapper<YIELD> = [request.id, next.value]
              socket.emit(responseTopic, wrapUndefinedYield(yieldWrapper))
            } catch (e) {
              // Re-throw the remote generator's error on the client
              const errorMsg = isError(e) ? e.message : e
              const msg = errorMsg || `Unknown Endpoint error for contract '${uniqueName}'`

              const errorWrapper: ErrorWrapper = {
                i: request.id,
                err: msg,
              }
              socket.emit(responseTopic, errorWrapper)
              const err = isError(e) ? e : new Error(JSON.stringify(e))
              log(err.message)
              return
            }
          }
        }
        socket.on(requestTopic, requestHandler)
        socket.once('disconnect', () => {
          log(`${getSocketId(socket)} disconnected from ${uniqueName}`)
          socket.off(requestTopic, requestHandler)
        })
      }
    }
  }
  return {
    newClient,
    newEndpoint,
  }
}

function getSocketId(socket: ClientSocket | ServerSocket): string {
  if (socket['handshake']) {
    return (socket as ServerSocket).handshake.address
  }
  return 'remote'
}

export class NetworkError extends Error {
  public readonly cause: 'network disconnect'

  public constructor(msg: string, cause: 'network disconnect') {
    super(msg)
    this.cause = cause
  }
}

export function isNetworkError(e: object): e is NetworkError {
  return isError(e) && ['network disconnect'].includes(e['cause'])
}

const NOOP_LOGGER = () => { }

type RequestWrapper<REQ> = {
  id: string
  req: REQ
}

type YieldWrapper<YIELD> = [string, YIELD]

type ErrorWrapper = {
  i: string
  err: string
}

type ReturnWrapper<RETURN> = {
  i: string
  r: RETURN
}

type UndefinedWrapper<Y, R> = {
  u: YieldWrapper<Y> | ReturnWrapper<R>
}

export async function sleep(ms: number): Promise<void> {
  return new Promise((res) => {
    setTimeout(() => {
      res()
    }, ms)
  })
}

function isIterResult(obj: object): obj is { next: () => unknown } {
  return typeof (obj) === 'object' && obj['next'] !== undefined && typeof (obj['next']) === 'function'
}

function isError(e: object): e is Error {
  return e && typeof (e) === 'object' && e['message'] !== undefined && e['name'] !== undefined
}

function isReturnWrapper(r: ReturnWrapper<unknown> | YieldWrapper<unknown> | ErrorWrapper): r is ReturnWrapper<unknown> {
  return typeof r === 'object' && 'r' in r
}

function isUndefinedWrapper(u: UndefinedWrapper<unknown, unknown> | ReturnWrapper<unknown> | YieldWrapper<unknown> | ErrorWrapper): u is UndefinedWrapper<unknown, unknown> {
  return typeof u === 'object' && 'u' in u
}

function isErrorWrapper(r: UndefinedWrapper<unknown, unknown> | ErrorWrapper | ReturnWrapper<unknown> | YieldWrapper<unknown>): r is ErrorWrapper {
  return typeof r === 'object' && 'err' in r
}

function wrapUndefinedYield<Y, R>(toWrap: YieldWrapper<Y>): YieldWrapper<Y> | UndefinedWrapper<Y, R> {
  if (toWrap[1] === undefined) {
    return {
      u: toWrap
    }
  }
  return toWrap
}

function wrapUndefinedReturn<Y, R>(toWrap: ReturnWrapper<R>): ReturnWrapper<R> | UndefinedWrapper<Y, R> {
  if (toWrap.r === undefined) {
    return {
      u: toWrap
    }
  }
  return toWrap
}

function unwrap<Y, R, W extends ErrorWrapper | ReturnWrapper<R> | YieldWrapper<Y>>(
  wrapped: UndefinedWrapper<Y, R> | W) : W {
  if (isErrorWrapper(wrapped)) {
    return wrapped
  }
  if (isUndefinedWrapper(wrapped)) {
    const inner = wrapped.u
    if (Array.isArray(inner)) {
      return [inner[0], undefined] as W
    } else {
      return {
        i: inner.i,
        r: undefined,
      } as W
    }
  }
  return wrapped
}

type Resolver<T> = (r: T) => void

export class BlockingQueue<T> {
  private resolvers: Resolver<T>[]
  private promises: Promise<T>[]

  constructor() {
    this.resolvers = [] as Resolver<T>[]
    this.promises = [] as Promise<T>[]
  }

  _push() {
    this.promises.push(
      new Promise((resolve) => {
        this.resolvers.push(resolve)
      })
    )
  }

  enqueue(t: T) {
    if (!this.resolvers.length) {
      this._push()
    }
    const shifted = this.resolvers.shift() as Resolver<T>
    shifted(t)
  }

  dequeue(): Promise<T> {
    if (!this.promises.length) {
      this._push()
    }
    return this.promises.shift() as Promise<T>
  }
}
