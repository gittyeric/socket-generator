import { Socket as ServerSocket } from "socket.io";
import { Socket as ClientSocket } from 'socket.io-client';
export declare type ClientFn<PARAMS extends unknown[], YIELD, RETURN> = (...req: PARAMS) => AsyncGenerator<YIELD, RETURN, undefined>;
export declare type Endpoint = {
    bindClient: (socket: ServerSocket | ClientSocket) => void;
};
export declare type Contract<PARAMS extends unknown[], YIELD, RETURN> = {
    newClient: (socket: ClientSocket<any, any>, timeoutMs?: number) => ClientFn<PARAMS, YIELD, RETURN>;
    newEndpoint: (responseGenerator: (...req: PARAMS) => AsyncGenerator<YIELD, RETURN, undefined> | Promise<RETURN>, logger?: (msg: string) => void) => Endpoint;
};
export declare function newContract<PARAMS extends unknown[], YIELD, RETURN>(uniqueName: string): {
    newClient: (socket: ClientSocket | ServerSocket, timeoutMs?: number) => ClientFn<PARAMS, YIELD, RETURN>;
    newEndpoint: (responseGenerator: (...req: PARAMS) => AsyncGenerator<YIELD, RETURN, undefined> | Promise<RETURN>, logger?: ((msg: string) => void) | undefined) => {
        bindClient: (socket: ServerSocket | ClientSocket) => void;
    };
};
export declare class NetworkError extends Error {
    readonly cause: 'network disconnect';
    constructor(msg: string, cause: 'network disconnect');
}
export declare function isNetworkError(e: any): e is NetworkError;
export declare function sleep(ms: number): Promise<void>;
export declare class BlockingQueue<T> {
    private resolvers;
    private promises;
    constructor();
    _push(): void;
    enqueue(t: T): void;
    dequeue(): Promise<T>;
}
