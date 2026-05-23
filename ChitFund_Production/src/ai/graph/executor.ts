import type { WorkflowState } from './state';

export type NodeFn = (state: WorkflowState) => Promise<WorkflowState>;
// Returns the next node name, or null to end the graph
export type RouterFn = (state: WorkflowState) => string | null;

export class GraphExecutor {
  private nodes = new Map<string, NodeFn>();
  private edges = new Map<string, RouterFn>();

  node(name: string, fn: NodeFn): this {
    this.nodes.set(name, fn);
    return this;
  }

  // Conditional routing via a function
  edge(from: string, router: RouterFn): this {
    this.edges.set(from, router);
    return this;
  }

  // Unconditional edge
  then(from: string, to: string): this {
    return this.edge(from, () => to);
  }

  async run(startNode: string, initialState: WorkflowState): Promise<WorkflowState> {
    let state = initialState;
    let current: string | null = startNode;

    while (current !== null) {
      const fn = this.nodes.get(current);
      if (!fn) throw new Error(`GraphExecutor: unknown node "${current}"`);

      const t0 = Date.now();
      try {
        state = await fn(state);
      } catch (err) {
        const msg = `[${current}] ${(err as Error).message}`;
        state.meta.errors.push(msg);
        console.error(msg, err);
        break;
      }

      state.meta.nodesExecuted.push(current);
      state.meta.durationMs[current] = Date.now() - t0;

      const router = this.edges.get(current);
      current = router ? router(state) : null;
    }

    return state;
  }
}
