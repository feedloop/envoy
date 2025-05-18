import { RouteResult, StateContext, StateDescriptor, StateRouter } from "./types";
import { StateMachine } from "./StateMachine";


/**
 * A StateNode is a node in the state machine.
 * It is responsible for handling the state of the state machine.
 */
export class StateNode {
    readonly name: string;
    private _router?: StateRouter;
    private _onEnterHandler: (ctx: StateContext) => Promise<StateContext>;
    private _onExitHandler: (ctx: StateContext) => Promise<StateContext>;
    private _onStateHandler: (ctx: StateContext) => Promise<StateContext>;

    constructor(readonly stateMachine: StateMachine, 
        readonly descriptor: StateDescriptor) {
        this.name = descriptor.name;
        this.stateMachine = stateMachine;
        this._router = descriptor.router;
        this._onEnterHandler = descriptor.onEnter || (async (state: StateContext) => state);
        this._onExitHandler = descriptor.onExit || (async (state: StateContext) => state);
        this._onStateHandler = descriptor.onState || (async (state: StateContext) => state);
    }

    public async onEnter(ctx: StateContext): Promise<StateContext> {
        ctx = ctx.clone();
        let plugins = this.stateMachine.plugins();
        for (let plugin of plugins) {
            if (plugin.onEnter) {
                ctx = await plugin.onEnter(ctx);
            }
        }
        if (this._onEnterHandler) {
            ctx = await this._onEnterHandler(ctx);
        }
        return ctx;
    }

    public async onExit(ctx: StateContext): Promise<StateContext> {
        ctx = ctx.clone();
        let plugins = this.stateMachine.plugins();
        for (let plugin of plugins) {
            if (plugin.onExit) {
                ctx = await plugin.onExit(ctx);
            }
        }
        if (this._onExitHandler) {
            ctx = await this._onExitHandler(ctx);
        }
        return ctx;
    }

    public async onState(ctx: StateContext): Promise<StateContext> {
        ctx = ctx.clone();
        return this._onStateHandler(ctx);
    }

    private _nextNode(): StateNode | null {
        let nodes = this.stateMachine.nodes();
        let index = nodes.indexOf(this);
        if (index === -1) {
            return null;
        }
        let nextNode = nodes[index + 1] || null;
        if (nextNode) {
            return nextNode;
        }
        return null;
    }

    public async route(ctx: StateContext): Promise<RouteResult | null> {
        let proposedNext: RouteResult | null = null;

        if (!this._router) {
            const nextNode = this._nextNode();
            proposedNext = nextNode ? {state: nextNode.name, input: ctx.output() ?? null} : null;
        } else if ("next" in this._router) {
            if (this._router.next === null) {
                proposedNext = null;
            } else {
                proposedNext = {state: this._router.next, input: ctx.output() ?? null};
            }
        } else if ("routes" in this._router) {
            proposedNext = await this._router.router(ctx);
        }

        // Debug: print proposedNext before plugins
        
        // Plugin interception
        for (const plugin of this.stateMachine.plugins()) {
            if (plugin.onRoute) {
                proposedNext = await plugin.onRoute(ctx, proposedNext);
            }
        }
        // Debug: print proposedNext after plugins
        

        // Return null if the proposed state does not exist in the state machine
        if (proposedNext) {
            const node = this.stateMachine.node(proposedNext.state);
            if (!node) {
                
                return null;
            }
        }

        // Debug: print final return value
        
        return proposedNext;
    }

    public nextNodes(): StateNode[] {
        let nodes: StateNode[] = [];
        if (!this._router) {
            let nextNode = this._nextNode();
            if (nextNode) {
                nodes.push(nextNode);
            }
        } else if ("next" in this._router) {
            if (this._router.next === null) {
                return nodes;
            }
            let nextNode = this.stateMachine.node(this._router.next);
            if (nextNode) {
                nodes.push(nextNode);
            }
        } else if ("routes" in this._router) {
            for (let route of Object.keys(this._router.routes)) {
                let node = this.stateMachine.node(route);
                if (node) {
                    nodes.push(node);
                }
            }
        }
        return nodes;
    }
}