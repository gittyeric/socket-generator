"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BlockingQueue = exports.sleep = exports.isNetworkError = exports.NetworkError = exports.newContract = void 0;
const uniqueNameSet = new Set();
function newContract(uniqueName) {
    if (uniqueNameSet.has(uniqueName)) {
        throw new Error(`A socket-generator Contract named ${uniqueName} already exists!`);
    }
    uniqueNameSet.add(uniqueName);
    const responseTopic = `_res_${uniqueName}`;
    const requestTopic = `_req_${uniqueName}`;
    function newClient(socket, timeoutMs = Number.POSITIVE_INFINITY) {
        let reqId = BigInt(1);
        return async function* newClientRequest(...req) {
            const curReqId = (reqId++).toString(36);
            const queue = new BlockingQueue();
            let timeoutRef = setTimeout(() => { }, 0);
            const pendingTimeout = timeoutMs < Number.MAX_SAFE_INTEGER
                ? new Promise((res) => {
                    timeoutRef = setTimeout(() => {
                        res(new Error(`Request timed out for ${uniqueName}`));
                    }, timeoutMs);
                })
                : new Promise(() => { });
            let rejectWithDisconnect = undefined;
            const disconnect = new Promise((res) => {
                rejectWithDisconnect = res;
            });
            const disconnectHandler = () => rejectWithDisconnect(new NetworkError('Network disconnected', 'network disconnect'));
            socket.on('disconnect', disconnectHandler);
            const responseHandler = (chunk) => {
                const unwrapped = unwrap(chunk);
                const reqId = Array.isArray(unwrapped) ? unwrapped[0] : unwrapped.i;
                if (reqId === curReqId) {
                    queue.enqueue(unwrapped);
                }
            };
            socket.on(responseTopic, responseHandler);
            function cleanup() {
                socket.off(responseTopic, responseHandler);
                socket.off('disconnect', disconnectHandler);
                clearTimeout(timeoutRef);
            }
            socket.emit(requestTopic, { id: curReqId, req });
            while (true) {
                const pendingChunk = queue.dequeue();
                const winner = await Promise.race([pendingChunk, pendingTimeout, disconnect]);
                if (isNetworkError(winner)) {
                    cleanup();
                    throw winner;
                }
                if (isError(winner)) {
                    cleanup();
                    throw winner;
                }
                if (isErrorWrapper(winner)) {
                    cleanup();
                    throw new Error(winner.err);
                }
                const unwrappedWinner = unwrap(winner);
                if (isReturnWrapper(unwrappedWinner)) {
                    cleanup();
                    return unwrappedWinner.r;
                }
                else {
                    yield unwrappedWinner[1];
                }
            }
        };
    }
    function newEndpoint(responseGenerator, logger) {
        const log = logger || NOOP_LOGGER;
        return {
            bindClient: (socket) => {
                log(`Opening endpoint ${uniqueName} for ${getSocketId(socket)}`);
                const requestHandler = async (request) => {
                    const gen = responseGenerator(...request.req);
                    const isGenerator = isIterResult(gen);
                    while (true) {
                        try {
                            const next = isGenerator ?
                                await gen.next() :
                                { done: true, value: (await gen) };
                            if (socket.disconnected) {
                                log(`Terminating in-flight response early, ${getSocketId(socket)} disconnected`);
                                return;
                            }
                            if (next.done) {
                                const returnWrapper = {
                                    i: request.id,
                                    r: next.value,
                                };
                                socket.emit(responseTopic, wrapUndefinedReturn(returnWrapper));
                                return;
                            }
                            const yieldWrapper = [request.id, next.value];
                            socket.emit(responseTopic, wrapUndefinedYield(yieldWrapper));
                        }
                        catch (e) {
                            const errorMsg = isError(e) ? e.message : e;
                            const msg = errorMsg || `Unknown Endpoint error for contract '${uniqueName}'`;
                            const errorWrapper = {
                                i: request.id,
                                err: msg,
                            };
                            socket.emit(responseTopic, errorWrapper);
                            const err = isError(e) ? e : new Error(JSON.stringify(e));
                            log(err.message);
                            return;
                        }
                    }
                };
                socket.on(requestTopic, requestHandler);
                socket.once('disconnect', () => {
                    log(`${getSocketId(socket)} disconnected from ${uniqueName}`);
                    socket.off(requestTopic, requestHandler);
                });
            }
        };
    }
    return {
        newClient,
        newEndpoint,
    };
}
exports.newContract = newContract;
function getSocketId(socket) {
    if (socket['handshake']) {
        return socket.handshake.address;
    }
    return 'remote';
}
class NetworkError extends Error {
    constructor(msg, cause) {
        super(msg);
        this.cause = cause;
    }
}
exports.NetworkError = NetworkError;
function isNetworkError(e) {
    return isError(e) && ['network disconnect'].includes(e['cause']);
}
exports.isNetworkError = isNetworkError;
const NOOP_LOGGER = () => { };
async function sleep(ms) {
    return new Promise((res) => {
        setTimeout(() => {
            res();
        }, ms);
    });
}
exports.sleep = sleep;
function isIterResult(obj) {
    return typeof (obj) === 'object' && obj['next'] !== undefined && typeof (obj['next']) === 'function';
}
function isError(e) {
    return e && typeof (e) === 'object' && e['message'] !== undefined && e['name'] !== undefined;
}
function isReturnWrapper(r) {
    return typeof r === 'object' && 'r' in r;
}
function isUndefinedWrapper(u) {
    return typeof u === 'object' && 'u' in u;
}
function isErrorWrapper(r) {
    return typeof r === 'object' && 'err' in r;
}
function wrapUndefinedYield(toWrap) {
    if (toWrap[1] === undefined) {
        return {
            u: toWrap
        };
    }
    return toWrap;
}
function wrapUndefinedReturn(toWrap) {
    if (toWrap.r === undefined) {
        return {
            u: toWrap
        };
    }
    return toWrap;
}
function unwrap(wrapped) {
    if (isErrorWrapper(wrapped)) {
        return wrapped;
    }
    if (isUndefinedWrapper(wrapped)) {
        const inner = wrapped.u;
        if (Array.isArray(inner)) {
            return [inner[0], undefined];
        }
        else {
            return {
                i: inner.i,
                r: undefined,
            };
        }
    }
    return wrapped;
}
class BlockingQueue {
    constructor() {
        this.resolvers = [];
        this.promises = [];
    }
    _push() {
        this.promises.push(new Promise((resolve) => {
            this.resolvers.push(resolve);
        }));
    }
    enqueue(t) {
        if (!this.resolvers.length) {
            this._push();
        }
        const shifted = this.resolvers.shift();
        shifted(t);
    }
    dequeue() {
        if (!this.promises.length) {
            this._push();
        }
        return this.promises.shift();
    }
}
exports.BlockingQueue = BlockingQueue;
//# sourceMappingURL=index.js.map