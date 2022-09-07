import { Contract, Endpoint, isNetworkError, newContract, sleep } from "../src"
import { Socket as ServerSocket } from "socket.io"
import { Socket as ClientSocket, io as clientIO } from 'socket.io-client'
import { Server } from "socket.io";

const TEST_ERR_MESSAGE = 'Test Error'

async function drainStream(stream: AsyncGenerator<number, number, undefined>): Promise<number[]> {
    const drained = [] as number[]
    while (true) {
        const n = await stream.next()
        drained.push(n.value)
        if (n.done) {
            break
        }
    }
    return drained
}

async function newSocketClient(
): Promise<ClientSocket> {
    const _clientSocket = clientIO('http://localhost:8080')
    _clientSocket.connect()
    return _clientSocket
}

async function newServer() {
    const server = new Server(8080, {
        cors: {
            origin: '*',
            //methods: ["GET", "POST", "PUT", "DELETE", "PATCH"],
        },
    });
    return {
        server,
    }
}

async function newClientServerSockets(customServer?: Server) {
    const server = customServer || (await newServer()).server
    const pendingClientSocket = await newSocketClient()
    let pendingServerSocket: Promise<ServerSocket> = new Promise((res, rej) => {
        server.on("connection", (_serverSocket) => {
            res(_serverSocket)
        });
    })
    return {
        server,
        serverSocket: await pendingServerSocket,
        clientSocket: await pendingClientSocket,
    }
}

async function closeSockets(clientSockets: ClientSocket[], server: Server, serverSockets: ServerSocket[]) {
    for (const clientSocket of clientSockets) {
        clientSocket.close()
    }
    for (const serverSocket of serverSockets) {
        serverSocket.disconnect()
    }
    await new Promise((res, rej) => {
        server.close(res)
    })
}

function newTestEndpoint<P extends unknown[], Y, R>(
    contract: Contract<P, Y, R>,
    toYield: Y[],
    toReturn: R,
    yieldDelay: number = 0,
    yieldsTillError: number = Number.POSITIVE_INFINITY): Endpoint {
    return contract.newEndpoint(async function* (...p: P) {
        let i = 0
        for (const y of toYield) {
            if (yieldsTillError === i) {
                throw new Error(TEST_ERR_MESSAGE)
            }
            await sleep(yieldDelay)
            yield y
            i++
        }
        return toReturn
    })
}


describe('Client / Server', () => {

    it("should pass parameters to generator", async () => {
        const { clientSocket, serverSocket, server } = await newClientServerSockets()
        const addOneContract = newContract<[number, number], number, number>('passParams')
        addOneContract.newEndpoint(async function* (startNum: number, incrementAmount: number) {
            yield startNum
            yield startNum + incrementAmount
            return startNum + incrementAmount * 2
        }).bindClient(serverSocket)
        const addOneClient = addOneContract.newClient(clientSocket)
        const addOneStream = addOneClient(10, 2)

        const firstYield = await addOneStream.next()
        const secondYield = await addOneStream.next()
        const returnVal = await addOneStream.next()

        expect(firstYield.done).toEqual(false)
        expect(firstYield.value).toEqual(10)
        expect(secondYield.done).toEqual(false)
        expect(secondYield.value).toEqual(12)
        expect(returnVal.done).toEqual(true)
        expect(returnVal.value).toEqual(14)

        await closeSockets([clientSocket], server, [serverSocket])
    })

    it("should work with non-generator async functions too", async () => {
        const { clientSocket, serverSocket, server } = await newClientServerSockets()
        const allOnesContract = newContract<never, never, number>('asyncFn')
        allOnesContract.newEndpoint(async function () {
            return 1
        }).bindClient(serverSocket)
        const allOnesClient = allOnesContract.newClient(clientSocket)
        const allTruesStream = allOnesClient()

        const returnVal = await allTruesStream.next()
        const repeatedReturnVal = await allTruesStream.next()

        expect(returnVal.done).toEqual(true)
        expect(returnVal.value).toEqual(1)
        expect(repeatedReturnVal.done).toEqual(true)
        expect(repeatedReturnVal.value).toEqual(undefined)

        await closeSockets([clientSocket], server, [serverSocket])
    })

    it("should yield and return the Endpoint generator function's values", async () => {
        const { clientSocket, serverSocket, server } = await newClientServerSockets()
        const allOnesContract = newContract<never, 1, 1>('allOnes')
        newTestEndpoint(allOnesContract, [1, 1], 1)
            .bindClient(serverSocket)
        const allOnesClient = allOnesContract.newClient(clientSocket)
        const allTruesStream = allOnesClient()

        const firstYield = await allTruesStream.next()
        const secondYield = await allTruesStream.next()
        const returnVal = await allTruesStream.next()
        const repeatedReturnVal = await allTruesStream.next()

        expect(firstYield.done).toEqual(false)
        expect(firstYield.value).toEqual(1)
        expect(secondYield.done).toEqual(false)
        expect(secondYield.value).toEqual(1)
        expect(returnVal.done).toEqual(true)
        expect(returnVal.value).toEqual(1)
        expect(repeatedReturnVal.done).toEqual(true)
        expect(repeatedReturnVal.value).toEqual(undefined)

        await closeSockets([clientSocket], server, [serverSocket])
    })

    it("should be bi-directional, server as a ClientFn and client as an Endpoint", async () => {
        const { clientSocket, serverSocket, server } = await newClientServerSockets()
        const allOnesContract = newContract<never, 1, 1>('bidirectional')
        newTestEndpoint(allOnesContract, [1], 1)
            .bindClient(clientSocket)
        const allOnesClient = allOnesContract.newClient(serverSocket)
        const allTruesStream = allOnesClient()

        const firstYield = await allTruesStream.next()
        const returnVal = await allTruesStream.next()

        expect(firstYield.done).toEqual(false)
        expect(firstYield.value).toEqual(1)
        expect(returnVal.done).toEqual(true)
        expect(returnVal.value).toEqual(1)

        await closeSockets([clientSocket], server, [serverSocket])
    })

    it("should work with no yields", async () => {
        const { clientSocket, serverSocket, server } = await newClientServerSockets()
        const allOnesContract = newContract<never, 1, 1>('noYields')
        newTestEndpoint(allOnesContract, [], 1)
            .bindClient(serverSocket)
        const allOnesClient = allOnesContract.newClient(clientSocket)
        const allTruesStream = allOnesClient()

        const returnVal = await allTruesStream.next()
        const repeatedReturnVal = await allTruesStream.next()

        expect(returnVal.done).toEqual(true)
        expect(returnVal.value).toEqual(1)
        expect(repeatedReturnVal.done).toEqual(true)
        expect(repeatedReturnVal.value).toEqual(undefined)

        await closeSockets([clientSocket], server, [serverSocket])
    })

    it("should handle objects", async () => {
        const { clientSocket, serverSocket, server } = await newClientServerSockets()
        type SomeObj = { num: number, str: string } | {} | string[]
        const allOnesContract = newContract<never, SomeObj, SomeObj>('objs')
        newTestEndpoint(allOnesContract, [{ num: 1, str: "1" }, {}, ['hello'], []], { num: 2, str: "2" })
            .bindClient(serverSocket)
        const someObjsClient = allOnesContract.newClient(clientSocket)
        const someObjsStream = someObjsClient()

        const firstYield = await someObjsStream.next()
        const secondYield = await someObjsStream.next()
        const thirdYield = await someObjsStream.next()
        const fourthYield = await someObjsStream.next()
        const returnVal = await someObjsStream.next()
        const repeatedReturnVal = await someObjsStream.next()

        expect(firstYield.done).toEqual(false)
        expect(firstYield.value).toMatchObject({ num: 1, str: "1" })
        expect(secondYield.value).toEqual({})
        expect(thirdYield.value).toEqual(['hello'])
        expect(fourthYield.value).toEqual([])
        expect(returnVal.done).toEqual(true)
        expect(returnVal.value).toMatchObject({ num: 2, str: "2" })
        expect(repeatedReturnVal.done).toEqual(true)
        expect(repeatedReturnVal.value).toEqual(undefined)

        await closeSockets([clientSocket], server, [serverSocket])
    })

    it("should force endpoint to quit mid-stream and client throws if network disconnects", async () => {
        const { clientSocket, serverSocket, server } = await newClientServerSockets()
        const buggyContract = newContract<never, number, number>('disconnecting')
        let lastYield = 0
        buggyContract.newEndpoint(async function* () {
            lastYield = 1
            yield 1
            await sleep(200)
            lastYield = 2
            yield 2
            return 2
        }).bindClient(serverSocket)
        const buggyClient = buggyContract.newClient(clientSocket)
        const buggyStream = buggyClient()

        const firstYield = await buggyStream.next()
        expect(firstYield.done).toEqual(false)
        expect(firstYield.value).toEqual(1)

        let netErrorSeen = false
        try {
            const pendingNext = buggyStream.next()
            // Force a disconnect before next yield can finish
            clientSocket.disconnect()
            serverSocket.disconnect()
            await pendingNext
        } catch (e) {
            netErrorSeen = isNetworkError(e)
            expect(e.cause).toEqual('network disconnect')
        }
        expect(netErrorSeen).toEqual(true)
        // Give just enough time for lastYield to update to 2
        await sleep(200)
        expect(lastYield).toEqual(2)

        await closeSockets([clientSocket], server, [serverSocket])
    })

    it("should throw generator function timeouts to client", async () => {
        const { clientSocket, serverSocket, server } = await newClientServerSockets()
        const slowContract = newContract<never, number, number>('timeout')
        const slowClient = slowContract.newClient(clientSocket, 1)
        const slowStream = slowClient()

        // Now the next yield should throw error
        let errorSeen = false
        try {
            await slowStream.next()
        } catch (e) {
            errorSeen = true
            expect(e.message).toContain('time')
        }
        expect(errorSeen).toEqual(true)

        server.close()
        await closeSockets([clientSocket], server, [serverSocket])
    })

    it("should re-throw generator function errors to client", async () => {
        const { clientSocket, serverSocket, server } = await newClientServerSockets()
        const buggyGenerator = newContract<never, number, number>('buggy')
        buggyGenerator.newEndpoint(async function* () {
            yield 1
            if (1 === 1) {
                throw new Error(TEST_ERR_MESSAGE)
            }
            return 2
        }).bindClient(serverSocket)
        const buggyClient = buggyGenerator.newClient(clientSocket)
        const buggyStream = buggyClient()

        const firstYield = await buggyStream.next()
        expect(firstYield.done).toEqual(false)
        expect(firstYield.value).toEqual(1)

        // Now the next yield should throw error
        let errorSeen = false
        try {
            await buggyStream.next()
        } catch (e) {
            errorSeen = true
            expect(e.message).toEqual(TEST_ERR_MESSAGE)
        }
        expect(errorSeen).toEqual(true)

        await closeSockets([clientSocket], server, [serverSocket])
    })

    it("should re-throw generator function (non) errors to client", async () => {
        const { clientSocket, serverSocket, server } = await newClientServerSockets()
        const buggyGenerator = newContract<never, number, number>('buggy2')
        buggyGenerator.newEndpoint(async function* () {
            yield 1
            if (1 === 1) {
                throw null
            }
            return 2
        }).bindClient(serverSocket)
        const buggyClient = buggyGenerator.newClient(clientSocket)
        const buggyStream = buggyClient()

        const firstYield = await buggyStream.next()
        expect(firstYield.done).toEqual(false)
        expect(firstYield.value).toEqual(1)

        // Now the next yield should throw error
        let errorSeen = false
        try {
            await buggyStream.next()
        } catch (e) {
            errorSeen = true
            expect(e.message).toContain('error')
        }
        expect(errorSeen).toEqual(true)

        await closeSockets([clientSocket], server, [serverSocket])
    })

    it("should handle many concurrent requests on the same contract", async () => {
        const { clientSocket, serverSocket, server } = await newClientServerSockets()

        const addOneContract = newContract<[number], number, number>('concurrent-contract')
        addOneContract.newEndpoint(async function* (startNum: number) {
            for (let j = 0; j < 20; j++) {
                yield startNum + j
            }
            return startNum + 20
        }).bindClient(serverSocket)
        const addOneClient = addOneContract.newClient(clientSocket)
        const streams = [] as AsyncGenerator<number, number, undefined>[]
        for (let i = 0; i < 20; i++) {
            const addOneStream = addOneClient(i * 1000)
            streams.push(addOneStream)
        }

        const allDrained = await Promise.all(streams.map((stream) => drainStream(stream)))
        for (let i = 0; i < 20; i++) {
            const drained = allDrained[i]
            const startNum = i * 1000
            for (let j = 0; j < 21; j++) {
                expect(startNum + j).toEqual(drained[j])
            }
        }

        await closeSockets([clientSocket], server, [serverSocket])
    })

    it("should handle multiple sockets", async () => {
        const { server } = await newServer()

        const addOneContract = newContract<[number], number, number>('many-sockets')
        const streams = [] as AsyncGenerator<number, number, undefined>[]
        const clients = [] as ClientSocket[]
        const serverSockets = [] as ServerSocket[]
        const endpoint = addOneContract.newEndpoint(async function* (startNum: number) {
            for (let j = 0; j < 20; j++) {
                yield startNum + j
            }
            return startNum + 20
        })
        for (let i = 0; i < 50; i++) {
            const { clientSocket, serverSocket } = await newClientServerSockets(server)
            clients.push(clientSocket)
            serverSockets.push(serverSocket)
            endpoint.bindClient(serverSocket)
        }
        for (let i = 0; i < 50; i++) {
            const addOneClient = addOneContract.newClient(await clients[i])
            const addOneStream = addOneClient(i * 1000)
            streams.push(addOneStream)
        }

        const allDrained = await Promise.all(streams.map((stream) => drainStream(stream)))
        for (let i = 0; i < 50; i++) {
            const drained = allDrained[i]
            const startNum = i * 1000
            for (let j = 0; j < 21; j++) {
                expect(startNum + j).toEqual(drained[j])
            }
        }

        await closeSockets(clients, server, serverSockets)
    })

    it("should route request/responses correctly across many parallel contracts", async () => {
        const { clientSocket, serverSocket, server } = await newClientServerSockets()

        const streams = [] as AsyncGenerator<number, number, undefined>[]
        for (let i = 0; i < 100; i++) {
            const addOneContract = newContract<[number], number, number>('parallel-contract-' + i)
            addOneContract.newEndpoint(async function* (startNum: number) {
                for (let j = 0; j < 100; j++) {
                    yield startNum + j
                }
                return startNum + 100
            }).bindClient(serverSocket)
            const addOneClient = addOneContract.newClient(clientSocket)
            const addOneStream = addOneClient(i * 1000)
            streams.push(addOneStream)
        }

        const allDrained = await Promise.all(streams.map((stream) => drainStream(stream)))
        for (let i = 0; i < 100; i++) {
            const drained = allDrained[i]
            const startNum = i * 1000
            for (let j = 0; j < 101; j++) {
                expect(startNum + j).toEqual(drained[j])
            }
        }

        await closeSockets([clientSocket], server, [serverSocket])
    })

    it("should work with undefined yields and returns", async () => {
        const { clientSocket, serverSocket, server } = await newClientServerSockets()
        const allUndefinedContract = newContract<never, undefined, undefined>('returnUndefined')
        newTestEndpoint(allUndefinedContract, [undefined], undefined)
            .bindClient(serverSocket)
        const allUndefinedClient = allUndefinedContract.newClient(clientSocket)
        const allUndefinedStream = allUndefinedClient()

        const yieldVal = await allUndefinedStream.next()
        const returnVal = await allUndefinedStream.next()

        expect(yieldVal.done).toEqual(false)
        expect(yieldVal.value).toEqual(undefined)
        expect(returnVal.done).toEqual(true)
        expect(returnVal.value).toEqual(undefined)

        await closeSockets([clientSocket], server, [serverSocket])
    })
})

describe('Contract', () => {
    it('should throw when non-unique named clients are created', () => {
        newContract('hello')
        let threw = false
        try {
            newContract('hello')
        } catch (e) {
            threw = true
        }
        expect(threw).toBeTruthy()
    })
})