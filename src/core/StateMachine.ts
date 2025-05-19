import { Json } from "../types";
import { StateNode } from "./StateNode";
import { StateObject } from "./StateObject";
import { StateMachinePlugin, StateContext, StateDescriptor } from "./types";
import { v4 as uuidv4 } from 'uuid';


export type StateMachineOptions = {
    startState?: string;
    plugins?: StateMachinePlugin[];
    maxSteps?: number;
}

export class StateMachine<T extends StateContext = StateContext> {

    private _startState: string = "start";
    private _maxSteps: number = 25;
    private _plugins: StateMachinePlugin[] = [];
    private _nodes: StateNode[] = [];

    constructor(_states: StateDescriptor[] = [], options: StateMachineOptions = {}) {
        this._nodes = _states.map(state => new StateNode(this, state));
        this._maxSteps = options.maxSteps || 25;
        this._startState = options.startState || "start";
        // Dependency resolution for plugins
        const plugins = options.plugins || [];
        this._plugins = StateMachine.resolvePluginDependencies(plugins);
    }

    public static resolvePluginDependencies(plugins: StateMachinePlugin[]): StateMachinePlugin[] {
        const resolved: StateMachinePlugin[] = [];
        const pluginMap = new Map(plugins.map(p => [p.name, p]));
        const visited = new Set<string>();
        function visit(plugin: StateMachinePlugin, stack: string[] = []) {
            if (resolved.includes(plugin)) return;
            if (visited.has(plugin.name)) return;
            visited.add(plugin.name);
            if (plugin.dependsOn) {
                for (const dep of plugin.dependsOn) {
                    const depPlugin = pluginMap.get(dep);
                    if (!depPlugin) {
                        throw new Error(`Plugin '${plugin.name}' depends on missing plugin '${dep}'`);
                    }
                    if (stack.includes(dep)) {
                        throw new Error(`Circular plugin dependency: ${[...stack, dep].join(' -> ')}`);
                    }
                    visit(depPlugin, [...stack, plugin.name]);
                }
            }
            resolved.push(plugin);
        }
        for (const plugin of plugins) {
            visit(plugin);
        }
        return resolved;
    }

    public drawGraph(): string {
        let graph = "graph TD\n";
        for (let node of this._nodes) {
            for (let nextNode of node.nextNodes()) {
                graph += `${node.name} --> ${nextNode.name}\n`;
            }
        }
        return graph;
    }

    public nodes(): StateNode[] {
        return [...this._nodes];
    }

    public node(name: string): StateNode | null {
        return this._nodes.find(node => node.name === name) || null;
    }

    public createNode(descriptor: StateDescriptor): StateNode {
        let node = new StateNode(this, descriptor);
        this._nodes.push(node);
        return node;
    }

    public plugins(): StateMachinePlugin[] {
        return this._plugins;
    }

    public plugin(name: string): StateMachinePlugin | null {
        return this._plugins.find(plugin => plugin.name === name) || null;
    }

    public addPlugin(plugin: StateMachinePlugin): void {
        // Only add if dependencies are met
        if (plugin.dependsOn) {
            for (const dep of plugin.dependsOn) {
                if (!this._plugins.find(p => p.name === dep)) {
                    throw new Error(`Plugin '${plugin.name}' depends on missing plugin '${dep}'`);
                }
            }
        }
        this._plugins.push(plugin);
    }

    public async step(_ctx: T): Promise<T> {
        let ctx = _ctx as unknown as StateObject;

        let node = this.node(ctx.state());
        if (!node) {
            throw new Error(`State ${ctx.state} not found`);
        }
        // Debug: print current state and execState
        
        // execute onEnter
        if (ctx.execState() === "enter") {
            ctx = await node.onEnter(ctx) as StateObject;
            ctx.cycleExecState();
        }

        // execute onState
        if (ctx.execState() === "state") {
            ctx = await node.onState(ctx) as StateObject;
            ctx.cycleExecState();
        }

        if (ctx.isWaitingFor().length > 0) {
            return ctx as unknown as T;
        }
        
        if (ctx.execState() === "waiting" && ctx.isWaitingFor().length === 0) {
            ctx.cycleExecState();
        }

        // execute onExit
        if (ctx.execState() === "exit") {
            ctx = await node.onExit(ctx) as StateObject;
            ctx.cycleExecState();
        }

        let next = await node.route(ctx);
        // Debug: print next state result
        
        let newCtx = ctx.clone();

        if (next) {
            newCtx.setInput(next.input ?? null);
            newCtx.clearOutput();
            newCtx.setState(next.state);
            newCtx.setStep(ctx.step() + 1);
            newCtx.resetExecState();
        } else {
            newCtx.setDone();
        }

        // Debug: print new context state
        
        return newCtx as unknown as T;
    }

    public newContext(input: Json): T {
        let ctx = new StateObject(this._startState, 1, input);
        return ctx as unknown as T;
    }

    public async run(input: Json): Promise<T> {
        let ctx = await this.newContext(input);
        while (!ctx.done()) {
            ctx = await this.step(ctx);
        }
        return ctx;
    }
}