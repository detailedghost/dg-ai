// Server-side D2 -> SVG rendering for the erd-renderer-comparison prototype.
// @terrastruct/d2's "node-esm" build runs its WASM engine directly in Bun/Node
// with no browser or DOM — confirmed by a throwaway script before wiring this
// in. That means D2 diagrams can be pre-rendered at Astro's server-render step
// and embedded as static SVG, same as any other server-computed prop. See
// .agents/prototype/erd-renderer-comparison/NOTES.md for why this beat the
// client-WASM fallback.
import { D2 } from "@terrastruct/d2";

// Shared classes so schema + flowchart diagrams match the dark-neon palette
// used by the Mermaid and Cytoscape variants (#15263f fill / #3aa0ff border /
// #4cc9f0 line) as closely as D2's styling model allows.
const SHARED_CLASSES = `
classes: {
  node-style: {
    style: {
      fill: "#15263f"
      stroke: "#3aa0ff"
      font-color: "#e6f1ff"
    }
  }
  edge-style: {
    style: {
      stroke: "#4cc9f0"
      stroke-width: 2
    }
  }
}
`;

// Dark Mauve — closest built-in D2 theme to a dark canvas; per-shape classes
// above still carry the actual palette match.
const DARK_THEME_ID = 200;

export async function renderD2(body: string): Promise<string> {
	const d2 = new D2();
	const result = await d2.compile(SHARED_CLASSES + body, { layout: "dagre" });
	return d2.render(result.diagram, { ...result.renderOptions, themeID: DARK_THEME_ID, pad: 24 });
}
