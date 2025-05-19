import { StateNode } from '../../src/core/StateNode';
import { StateMachine } from '../../src/core/StateMachine';
import { StateContext, StateDescriptor } from '../../src/core/types';
import { StateObject } from '../../src/core/StateObject';

describe('StateNode', () => {
    const dummyCtx = new StateObject('A', 1, null);
    const makeMachine = () => new StateMachine([]);

    it('constructs with correct name, and handlers', () => {
        const desc: StateDescriptor = {
            name: 'A',
            onState: async (ctx) => ctx,
        };
        const node = new StateNode(makeMachine(), desc);
        expect(node.name).toBe('A');
    });

    it('calls onEnter, onState, onExit handlers', async () => {
        let called: string[] = [];
        const desc: StateDescriptor = {
            name: 'B',
            onEnter: async (ctx) => { called.push('enter'); return ctx; },
            onState: async (ctx) => { called.push('state'); return ctx; },
            onExit: async (ctx) => { called.push('exit'); return ctx; },
        };
        const node = new StateNode(makeMachine(), desc);
        await node.onEnter(dummyCtx);
        await node.onState(dummyCtx);
        await node.onExit(dummyCtx);
        expect(called).toEqual(['enter', 'state', 'exit']);
    });

    it('calls plugin handlers on enter/exit', async () => {
        const pluginCalls: string[] = [];
        const plugin = {
            name: 'test',
            onEnter: async (ctx: StateContext) => { pluginCalls.push('pluginEnter'); return ctx; },
            onExit: async (ctx: StateContext) => { pluginCalls.push('pluginExit'); return ctx; },
        };
        const machine = new StateMachine([], { plugins: [plugin] });
        const desc: StateDescriptor = {
            name: 'C',
            onEnter: async (ctx) => ctx,
            onState: async (ctx) => ctx,
            onExit: async (ctx) => ctx,
        };
        const node = new StateNode(machine, desc);
        await node.onEnter(dummyCtx);
        await node.onExit(dummyCtx);
        expect(pluginCalls).toEqual(['pluginEnter', 'pluginExit']);
    });

    it('routes to next node by default', async () => {
        const machine = new StateMachine([]);
        const descA: StateDescriptor = { name: 'A', onState: async (ctx) => ctx };
        const descB: StateDescriptor = { name: 'B', onState: async (ctx) => ctx };
        const nodeA = new StateNode(machine, descA);
        const nodeB = new StateNode(machine, descB);
        (machine as any)._nodes = [nodeA, nodeB]; // recast for test
        expect(await nodeA.route(dummyCtx)).toEqual({ state: 'B', input: null });
        expect(await nodeB.route(dummyCtx)).toBeNull();
    });

    it('routes using router.next', async () => {
        const machine = new StateMachine([]);
        const descA: StateDescriptor = {
            name: 'A',
            router: { next: 'B' },
            onState: async (ctx) => ctx
        };
        const descB: StateDescriptor = { name: 'B', onState: async (ctx) => ctx };
        const nodeA = new StateNode(machine, descA);
        const nodeB = new StateNode(machine, descB);
        (machine as any)._nodes = [nodeA, nodeB]; // recast for test
        expect(await nodeA.route(dummyCtx)).toEqual({ state: 'B', input: null });
    });

    it('routes using router.routes', async () => {
        const machine = new StateMachine([]);
        const descA: StateDescriptor = {
            name: 'A',
            router: {
                routes: {
                    B: { description: 'to B' },
                    C: { description: 'to C' }
                },
                onRoute: async (ctx) => {return {state: 'C', input: null}},
            },
            onState: async (ctx) => ctx
        };
        const descB: StateDescriptor = { name: 'B', onState: async (ctx) => ctx };
        const descC: StateDescriptor = { name: 'C', onState: async (ctx) => ctx };
        const nodeA = new StateNode(machine, descA);
        const nodeB = new StateNode(machine, descB);
        const nodeC = new StateNode(machine, descC);
        (machine as any)._nodes = [nodeA, nodeB, nodeC]; // recast for test
        expect(await nodeA.route(dummyCtx)).toEqual({ state: 'C', input: null });
    });

    it('nextNodes returns correct nodes', () => {
        const machine = new StateMachine([]);
        const descA: StateDescriptor = {
            name: 'A',
            router: { next: 'B' },
            onState: async (ctx) => ctx
        };
        const descB: StateDescriptor = { name: 'B', onState: async (ctx) => ctx };
        const nodeA = new StateNode(machine, descA);
        const nodeB = new StateNode(machine, descB);
        (machine as any)._nodes = [nodeA, nodeB]; // recast for test
        expect(nodeA.nextNodes()).toEqual([nodeB]);
        expect(nodeB.nextNodes()).toEqual([]);
    });

    it('throws if onEnter, onState, or onExit throws', async () => {
        const desc: StateDescriptor = {
            name: 'Err',
            onEnter: async () => { throw new Error('enter error'); },
            onState: async () => { throw new Error('state error'); },
            onExit: async () => { throw new Error('exit error'); },
        };
        const node = new StateNode(makeMachine(), desc);
        await expect(node.onEnter(dummyCtx)).rejects.toThrow('enter error');
        await expect(node.onState(dummyCtx)).rejects.toThrow('state error');
        await expect(node.onExit(dummyCtx)).rejects.toThrow('exit error');
    });

    it('throws if plugin onEnter/onExit throws', async () => {
        const plugin = {
            name: 'errPlugin',
            onEnter: async () => { throw new Error('plugin enter'); },
            onExit: async () => { throw new Error('plugin exit'); },
        };
        const machine = new StateMachine([], { plugins: [plugin] });
        const desc: StateDescriptor = {
            name: 'P',
            onEnter: async (ctx) => ctx,
            onState: async (ctx) => ctx,
            onExit: async (ctx) => ctx,
        };
        const node = new StateNode(machine, desc);
        await expect(node.onEnter(dummyCtx)).rejects.toThrow('plugin enter');
        await expect(node.onExit(dummyCtx)).rejects.toThrow('plugin exit');
    });

    it('router returns non-existent state, null, or undefined', async () => {
        const machine = new StateMachine([]);
        const desc: StateDescriptor = {
            name: 'A',
            router: {
                next: 'B',
                onRoute: async () => {return {state: 'Z', input: null}}, // Z does not exist
            },
            onState: async (ctx) => ctx
        };
        const nodeA = new StateNode(machine, desc);
        (machine as any)._nodes = [nodeA];
        await expect(nodeA.route(dummyCtx)).resolves.toBeNull();

        (desc.router as any).router = async () => null;
        await expect(nodeA.route(dummyCtx)).resolves.toBeNull();
        (desc.router as any).router = async () => undefined;
        await expect(nodeA.route(dummyCtx)).resolves.toBeNull();
    });

    it('handles absence of onEnter, onExit, or onState gracefully', async () => {
        const desc: StateDescriptor = {
            name: 'NoHandlers',
            onState: async ctx => ctx,
        };
        const node = new StateNode(makeMachine(), desc);
        await expect(node.onEnter(dummyCtx)).resolves.toEqual(dummyCtx);
        await expect(node.onState(dummyCtx)).resolves.toEqual(dummyCtx);
        await expect(node.onExit(dummyCtx)).resolves.toEqual(dummyCtx);
    });
}); 