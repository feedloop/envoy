import { StateObject } from '../../src/core/StateObject';
import { JsonObject } from '../../src/types';

describe('StateObject', () => {
    it('constructs with correct state, step, and input', () => {
        const obj = new StateObject('start', 1, 'input');
        expect(obj.state()).toBe('start');
        expect(obj.step()).toBe(1);
        expect(obj.input()).toBe('input');
        expect(obj.done()).toBeNull();
    });

    it('manages execution state transitions', () => {
        const obj = new StateObject('s', 1, 'i');
        expect(obj.execState()).toBe('enter');
        obj.cycleExecState();
        expect(obj.execState()).toBe('state');
        obj.cycleExecState();
        expect(obj.execState()).toBe('waiting');
        obj.cycleExecState();
        expect(obj.execState()).toBe('exit');
        obj.cycleExecState();
        expect(obj.execState()).toBe('finish');
        obj.resetExecState();
        expect(obj.execState()).toBe('enter');
    });

    it('handles waiting and resolution', () => {
        const obj = new StateObject('s', 1, 'i');
        obj.waitFor([{ id: 'a', type: 'sometype' }, { id: 'b', type: 'sometype' }]);
        expect(obj.isWaitingFor().sort()).toEqual(['a', 'b']);
        obj.resolve('a', 'success', { result: 42 });
        expect(obj.isWaitingFor().sort()).toEqual(['b']);
        obj.resolve('b', 'error', { error: 'fail' });
        expect(obj.isWaitingFor()).toEqual([]);
    });

    it('stores and retrieves data', () => {
        const obj = new StateObject('s', 1, 'i');
        obj.set('foo', 123);
        expect(obj.get('foo')).toBe(123);
    });

    it('clones itself deeply', () => {
        const obj = new StateObject('s', 1, 'i');
        obj.set('foo', 123);
        obj.waitFor([{ id: 'a', type: 'sometype' }]);
        const clone = obj.clone();
        expect(clone).not.toBe(obj);
        expect(clone.state()).toBe(obj.state());
        expect(clone.get('foo')).toBe(123);
        expect(clone.isWaitingFor()).toEqual(['a']);
    });

    it('serializes and deserializes correctly', () => {
        const obj = new StateObject('s', 1, 'i');
        obj.set('foo', 123);
        obj.waitFor([{ id: 'a', type: 'sometype'}]);
        obj.cycleExecState();
        obj.setDone('finished');
        const ser = obj.serialize();
        const from = StateObject.from(ser);
        expect(from.state()).toBe('s');
        expect(from.get('foo')).toBe(123);
        expect(from.isWaitingFor()).toEqual(['a']);
        expect(from.execState()).toBe(obj.execState());
        expect(from.done()).toBe('finished');
    });

    it('handles output', () => {
        const obj = new StateObject('s', 1, 'i');
        expect(obj.output()).toBeUndefined();
        obj.output({ result: 42 });
        expect(obj.output()).toEqual({ result: 42 });
    });

    it('returns the last value set by output', () => {
        const obj = new StateObject('s', 1, 'i');
        obj.output({ a: 1 });
        obj.output({ b: 2 });
        expect(obj.output()).toEqual({ b: 2 });
    });

    it('handles output with falsy/null/undefined values', () => {
        const obj = new StateObject('s', 1, 'i');
        obj.output(null);
        expect(obj.output()).toBeNull();
        obj.output(0);
        expect(obj.output()).toBe(0);
        obj.output('');
        expect(obj.output()).toBe('');
    });

    it('does not resolve keys not waited for', () => {
        const obj = new StateObject('s', 1, 'i');
        obj.waitFor([{ id: 'a', type: 'sometype'}]);
        obj.resolve('b', 'success', { result: 1 }); // should not throw
        expect(obj.isWaitingFor()).toEqual(['a']);
        obj.resolve('a', 'success', { result: 2 });
        expect(obj.isWaitingFor()).toEqual([]);
    });

    it('resolving the same key multiple times is safe', () => {
        const obj = new StateObject('s', 1, 'i');
        obj.waitFor([{ id: 'a', type: 'sometype' }]);
        obj.resolve('a', 'success', { result: 1 });
        expect(obj.isWaitingFor()).toEqual([]);
        obj.resolve('a', 'error', { error: 'fail' }); // should not throw
        expect(obj.isWaitingFor()).toEqual([]);
    });

    it('waitFor with empty array does nothing', () => {
        const obj = new StateObject('s', 1, 'i');
        obj.waitFor([]);
        expect(obj.isWaitingFor()).toEqual([]);
    });

    it('handles output subfield writing and reading', () => {
        const obj = new StateObject('s', 1, 'i');
        obj.output('jobs.child1', { result: 123 });
        obj.output('jobs.child2', { result: 456 });
        expect(obj.output()).toEqual({ jobs: { child1: { result: 123 }, child2: { result: 456 } } });
        // Overwrite a subfield
        obj.output('jobs.child1', { result: 789 });
        // Helper to get nested field
        const getNested = (obj: any, path: string) => path.split('.').reduce((o, k) => (o && o[k] !== undefined ? o[k] : undefined), obj);
        expect(getNested(obj.output(), 'jobs.child1')).toEqual({ result: 789 });
    });

    it('spawn creates a waitFor entry of type spawn', () => {
        const obj = new StateObject('s', 1, 'i');
        const id = obj.spawn('mySM', { foo: 42 });
        const waiting = obj.getWaitingMap();
        expect(waiting && waiting[id]).toBeDefined();
        if (waiting && waiting[id]) {
            expect(waiting[id].type).toBe('spawn');
            expect(waiting[id].params?.sm).toBe('mySM');
            expect(waiting[id].params?.input).toEqual({ foo: 42 });
        }
        expect(obj.isWaitingFor()).toContain(id);
    });
}); 