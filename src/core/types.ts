import { Json, JsonObject } from "../types";

export type StateMachinePlugin = {
    name: string;
    dependsOn?: string[];
    onEnter?: (state: StateContext) => Promise<StateContext>;
    onExit?: (state: StateContext) => Promise<StateContext>;
    onRoute?: (ctx: StateContext, proposedNext: RouteResult | null) => Promise<RouteResult | null>;
}

export type RouteResult = {
    state: string;
    input: Json;
}

export type EscalationInput = SelectInput | CommentInput | ApproveInput;

type SelectInput = {
    id: string;
    type: "select";
    label: string;
    options: {
        [key: string]: string;
    }
}

type CommentInput = {
    id: string;
    type: "comment";
    label: string;
}

type ApproveInput = {
    id: string;
    type: "approve";
    label: string;
}



export type StateDescriptor<T extends StateContext = StateContext> = {
    name: string;
    router?: StateRouter;
    onEnter?: (ctx: T) => Promise<T>;
    onWaiting?: (ctx: T) => Promise<T>;
    onExit?: (ctx: T) => Promise<T>;
    onState: (ctx: T) => Promise<T>;
}

export type StateRouter = {next: string | null} | {
    routes: {
        [key: string]: {
            description: string;
            default?: boolean;
        }
    }
    onRoute: (ctx: StateContext) => Promise<RouteResult | null>;
}

export type WaitFor = {
    id: string;
    type: string;
    params?: JsonObject;
}

export type WaitingContext = WaitFor & {
    status: "pending" | "success" | "error";
    output?: Json;
    error?: Json;
    childJobId?: string;
}

export type StateContext = {
    state(): string;
    step(): number;
    input<T extends Json>(): T;
    done(): "finished" | "error" | "cancelled" | "maxSteps" | null;
    output<T extends Json>(): T | undefined;
    output<T extends Json>(output: T): T | undefined;
    output<T extends Json>(path: string, value: T): void;
    waitFor(waitlist: WaitFor[]): void;
    isWaitingFor(): string[];
    spawn(sm: string, input: Json): string;
    escalate(user: string, message: string, inputs: EscalationInput[]): string;
    set<T extends Json>(key: string, value: T): void;
    get<T extends Json>(key: string): T;
    clone(newId?: boolean): StateContext;
    serialize(): SerializedState;
    [key: string]: any;
}

export type SerializedState = {
    state: string;
    step: number;
    input: Json;
    output: Json | null;
    execState: "enter" | "state" | "waiting" | "exit" | "finish";
    done: "finished" | "error" | "cancelled" | "maxSteps" | null;
    waiting: {
        [key: string]: WaitingContext
    };
    data: JsonObject;
}

export interface SchedulerOptions {
    concurrency?: number;
}