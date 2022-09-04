# socket-generator

Turn any JS/TS async generator / function into a typed Websocket stream in 2 lines.

## Why this?

There wasn't any easy way to turn my server's simple async generator functions into a Websocket stream without a lot of fuss, and Socket.io is
arguably the best Websocket streaming library, so why not make it easy to glue them together!?  Also,

- Mix and match plain async functions with async generators
- Bi-directional: frontends can be endpoints and servers can be clients, if you want
- Request / Response paradigm you're used to, but over Websockets with fallback to HTTP long polling
- Same mechanics you know and love from async generators, try/catch error handling etc.
- Zero dependencies (except implicitly on Socket.io >= v4)
- 100% line + branch test coverage, because you deserve it :-)

## Hello World Example:

#### Define a async generator function for streaming (usually only on the server)
```
async function* wordGenerator(input: string) {
  const words = input.split(' ');
  for (const word of words) {
    yield word;
  }
}
```

#### Define a shared contract where client sends a single string parameter and endpoint streams / yields strings back
```
const helloWorldContract = newContract<[string], number, undefined>('hello_world');
```

#### Define a client (usually just on the frontend) that can issue requests
```
const helloClient = helloWorldContract.newClient(clientSocket, 1);
```

#### Define an endpoint (usually just on the server) that can respond to requests and define the generator function
```
helloWorldContract.newEndpoint(wordGenerator).bindClient(serverSocket);
```

#### Client streams the server's wordGenerator function remotely as if it was local!
```
const wordGenerator = helloClient('hello world');
for await (const word of wordGenerator) {
  console.log(word);
}
```

See `__tests__/examples.test.ts` for all advanced usage and how to create Socket.io client / server sockets

## API

### newContract

 Creates a new Contract which is a shared type agreement between Socket.io client and endpoints.  Because Socket.io is bidirectional, front-ends may be endpoints and servers may be clients too! A client
 initializes a request by sending PARAMS and the endpoint responds with a stream of YIELDs ending in a RETURN.
 
 `@param uniqueName` A unique name for this Socket.io client / endpoint contract

 `@returns` A Contract instance that either client or endpoint can further instantiate with more context


```
function newContract<PARAMS extends unknown[], YIELD, RETURN>(uniqueName: string)
```

## API Types

### Contract
 An instantiated Contract is a factory pattern than can then be used to either create the ClientFn (after
 binding a client Socket.io socket) or an Endpoint (after binding both a server Socket.io socket and
 the contract's responseGenerator implementation)
```
type Contract<PARAMS extends unknown[], YIELD, RETURN> = {
  newClient: (
    socket: ClientSocket<any, any>, 
    timeoutMs?: number) => ClientFn<PARAMS, YIELD, RETURN>,
  newEndpoint: (
    socket: ServerSocket<any, any>,
    responseGenerator: (...req: PARAMS) => AsyncGenerator<YIELD, RETURN, undefined> | Promise<RETURN>,
    logger?: (msg: string) => void) => Endpoint
}
```

### ClientFn

 Creates an instance of an async generator that can be iterated to stream YIELDs from the parent Contract's endpoint, ending with a RETURN value when done

```
type ClientFn<PARAMS extends unknown[], YIELD, RETURN> = (
  ...req: PARAMS
) => AsyncGenerator<YIELD, RETURN, undefined>
```

### Endpoint

After initializing contract.newEndpoint, you can bind many client sockets to the new Endpoint by calling bindClient.

```
type Endpoint = {
  bindClient: (socket: ServerSocket) => void
}
```

## More Links

See official [Socket.io v4 documentation](https://socket.io/docs/v4/).