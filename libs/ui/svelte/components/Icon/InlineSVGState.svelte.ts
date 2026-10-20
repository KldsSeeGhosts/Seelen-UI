const svgs = $state<Record<string, string>>({});
const pending = new Map<string, Promise<void>>();

class InlineSVGState {
  get(src: string): string | undefined {
    return svgs[src];
  }

  async fetch(src: string): Promise<void> {
    if (src in svgs) return;
    let request = pending.get(src);
    if (!request) {
      request = (async () => {
        const response = await fetch(src);
        if (!response.ok) {
          throw new Error(`Failed to fetch SVG: ${response.statusText}`);
        }
        svgs[src] = await response.text();
      })().catch(console.error).finally(() => pending.delete(src));
      pending.set(src, request);
    }
    await request;
  }
}

export const inlineSVGState = new InlineSVGState();
