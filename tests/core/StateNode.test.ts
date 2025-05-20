import { StateNode } from '../../src/core/StateNode';
import { StateFlow } from '../../src/core/StateFlow';
import { StateContext, StateDescriptor } from '../../src/core/types';
import { StateObject } from '../../src/core/StateObject';

describe('StateNode', () => {
    const dummyCtx = new StateObject('A', 1, null);
    const makeMachine = () => new StateFlow([]);

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
        const machine = new StateFlow([], { plugins: [plugin] });
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
        const machine = new StateFlow([]);
        const descA: StateDescriptor = { name: 'A', onState: async (ctx) => ctx };
        const descB: StateDescriptor = { name: 'B', onState: async (ctx) => ctx };
        const nodeA = new StateNode(machine, descA);
        const nodeB = new StateNode(machine, descB);
        (machine as any)._nodes = [nodeA, nodeB]; // recast for test
        expect(await nodeA.route(dummyCtx)).toBe('B');
        expect(await nodeB.route(dummyCtx)).toBeNull();
    });

    it('routes using router.next', async () => {
        const machine = new StateFlow([]);
        const descA: StateDescriptor = {
            name: 'A',
            router: { next: 'B' },
            onState: async (ctx) => ctx
        };
        const descB: StateDescriptor = { name: 'B', onState: async (ctx) => ctx };
        const nodeA = new StateNode(machine, descA);
        const nodeB = new StateNode(machine, descB);
        (machine as any)._nodes = [nodeA, nodeB]; // recast for test
        expect(await nodeA.route(dummyCtx)).toBe('B');
    });

    it('routes using router.routes', async () => {
        const machine = new StateFlow([]);
        const descA: StateDescriptor = {
            name: 'A',
            router: {
                routes: {
                    B: { description: 'to B' },
                    C: { description: 'to C' }
                },
                onRoute: async (ctx) => 'C',
            },
            onState: async (ctx) => ctx
        };
        const descB: StateDescriptor = { name: 'B', onState: async (ctx) => ctx };
        const descC: StateDescriptor = { name: 'C', onState: async (ctx) => ctx };
        const nodeA = new StateNode(machine, descA);
        const nodeB = new StateNode(machine, descB);
        const nodeC = new StateNode(machine, descC);
        (machine as any)._nodes = [nodeA, nodeB, nodeC]; // recast for test
        expect(await nodeA.route(dummyCtx)).toBe('C');
    });

    it('nextNodes returns correct nodes', () => {
        const machine = new StateFlow([]);
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
        const machine = new StateFlow([], { plugins: [plugin] });
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
        const machine = new StateFlow([]);
        const desc: StateDescriptor = {
            name: 'A',
            router: {
                next: 'B',
                onRoute: async () => 'Z', // Z does not exist
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

    it('maps output using router.map', async () => {
        const machine = new StateFlow([]);
        const descA: StateDescriptor = {
            name: 'A',
            router: {
                next: 'B',
                map: (output, ctx) => {
                    // Example: just return output doubled if it's a number
                    if (typeof output === 'number') return (output * 2) as any;
                    return output;
                }
            },
            onState: async (ctx) => { ctx.output(21); return ctx; }
        };
        const descB: StateDescriptor = { name: 'B', onState: async (ctx) => ctx };
        const nodeA = new StateNode(machine, descA);
        const nodeB = new StateNode(machine, descB);
        (machine as any)._nodes = [nodeA, nodeB];
        const ctx = new StateObject('A', 1, null);
        ctx.output(21);
        const mapped = await nodeA.mapOutput(ctx, 'B');
        expect(mapped).toBe(42);
    });

    it('maps output using router.next + map', async () => {
        const machine = new StateFlow([]);
        const descA: StateDescriptor = {
            name: 'A',
            router: {
                next: 'B',
                map: (output, ctx) => {
                    if (typeof output === 'number') return (output + 1) as any;
                    return output;
                }
            },
            onState: async (ctx) => { ctx.output(10); return ctx; }
        };
        const descB: StateDescriptor = { name: 'B', onState: async (ctx) => ctx };
        const nodeA = new StateNode(machine, descA);
        const nodeB = new StateNode(machine, descB);
        (machine as any)._nodes = [nodeA, nodeB];
        const ctx = new StateObject('A', 1, null);
        ctx.output(10);
        const mapped = await nodeA.mapOutput(ctx, 'B');
        expect(mapped).toBe(11);
    });

    it('maps output using router.routes with function', async () => {
        const machine = new StateFlow([]);
        const descA: StateDescriptor = {
            name: 'A',
            router: {
                routes: {
                    B: (output, ctx) => {
                        if (typeof output === 'number') return (output * 3) as any;
                        return output;
                    }
                },
                onRoute: async (ctx) => 'B',
            },
            onState: async (ctx) => { ctx.output(5); return ctx; }
        };
        const descB: StateDescriptor = { name: 'B', onState: async (ctx) => ctx };
        const nodeA = new StateNode(machine, descA);
        const nodeB = new StateNode(machine, descB);
        (machine as any)._nodes = [nodeA, nodeB];
        const ctx = new StateObject('A', 1, null);
        ctx.output(5);
        const mapped = await nodeA.mapOutput(ctx, 'B');
        expect(mapped).toBe(15);
    });

    it('maps output using router.routes with object + map', async () => {
        const machine = new StateFlow([]);
        const descA: StateDescriptor = {
            name: 'A',
            router: {
                routes: {
                    B: {
                        description: 'to B',
                        map: (output, ctx) => {
                            if (typeof output === 'number') return (output - 2) as any;
                            return output;
                        }
                    }
                },
                onRoute: async (ctx) => 'B',
            },
            onState: async (ctx) => { ctx.output(8); return ctx; }
        };
        const descB: StateDescriptor = { name: 'B', onState: async (ctx) => ctx };
        const nodeA = new StateNode(machine, descA);
        const nodeB = new StateNode(machine, descB);
        (machine as any)._nodes = [nodeA, nodeB];
        const ctx = new StateObject('A', 1, null);
        ctx.output(8);
        const mapped = await nodeA.mapOutput(ctx, 'B');
        expect(mapped).toBe(6);
    });

    it('returns raw output if no map is defined for route', async () => {
        const machine = new StateFlow([]);
        const descA: StateDescriptor = {
            name: 'A',
            router: {
                routes: {
                    B: { description: 'to B' }
                },
                onRoute: async (ctx) => 'B',
            },
            onState: async (ctx) => { ctx.output(99); return ctx; }
        };
        const descB: StateDescriptor = { name: 'B', onState: async (ctx) => ctx };
        const nodeA = new StateNode(machine, descA);
        const nodeB = new StateNode(machine, descB);
        (machine as any)._nodes = [nodeA, nodeB];
        const ctx = new StateObject('A', 1, null);
        ctx.output(99);
        const mapped = await nodeA.mapOutput(ctx, 'B');
        expect(mapped).toBe(99);
    });
}); 