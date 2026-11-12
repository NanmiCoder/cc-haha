import lock from './skillBundles.lock.json'
import type { ConnectorCategory, ConnectorDefinition, SkillBundleRecipe } from './types.js'

// Sources, complete skill subtrees and license files are pinned in the lock.
// Installation only downloads verified files; runtimes are separate prerequisites.
export const SKILL_RECIPES: SkillBundleRecipe[] = lock

const details: Array<{ id: string, name: string, category: ConnectorCategory, description: string, example: string, requirements: string }> = [
  { id: 'hyperframes', name: 'HyperFrames', category: 'design', description: 'Create HTML videos, captions and product demos.', example: 'Create a 20-second product introduction with HyperFrames.', requirements: 'Installs five complete skills and references, not a renderer. Rendering needs Node.js 22+, HyperFrames CLI and FFmpeg. Local speech may need Python 3.10+; online media services need separate setup and may charge fees.' },
  { id: 'obsidian', name: 'Obsidian toolkit', category: 'productivity', description: 'Edit Markdown notes, Canvas boards and Bases views.', example: 'Turn these project notes into an Obsidian Canvas relationship map.', requirements: 'Local file editing needs no cloud account. CLI operations require Obsidian to be installed and running. Optional extraction and templating features need their own CLIs. Only skill files are installed.' },
  { id: 'drawio', name: 'draw.io diagrams', category: 'design', description: 'Create editable architecture, flow and relationship diagrams.', example: 'Turn this system description into an editable draw.io architecture diagram.', requirements: 'Write .drawio XML directly. Mermaid conversion, automatic layout and image export require the draw.io desktop CLI. Installing this skill does not install the desktop app.' },
  { id: 'frontend-design', name: 'Frontend design', category: 'design', description: 'Build frontend interfaces with clear visual hierarchy.', example: 'Design and implement a home page for my knowledge management app.', requirements: 'Installs the Anthropic frontend design skill. Previewing and building require the target project dependencies and runtime. Hosting and image generation services are not included.' },
  { id: 'canvas-design', name: 'Canvas design', category: 'design', description: 'Create posters, static artwork and PDF canvases, with bundled fonts.', example: 'Design a technology event poster and export it as PDF.', requirements: 'Includes the complete design skill, fonts and their licenses. Image or PDF generation needs Python and suitable drawing libraries, which are not installed automatically.' },
  { id: 'algorithmic-art', name: 'Algorithmic art', category: 'design', description: 'Create adjustable algorithmic art and interactive visuals with p5.js.', example: 'Build a flow-field artwork page with adjustable colors and density.', requirements: 'Includes templates and reference code. Previewing needs a browser and p5.js resources. Installation does not execute scripts or call generation models.' },
  { id: 'webapp-testing', name: 'Web app testing', category: 'development', description: 'Inspect local web pages, interactions and screenshots with Playwright.', example: 'Check form validation and layout in my local app.', requirements: 'Includes the testing skill, Python helpers and examples. Running tests needs Python, Playwright, a browser and the target app. Installation does not download browsers.' },
  { id: 'mcp-builder', name: 'MCP builder', category: 'development', description: 'Build and evaluate MCP servers with TypeScript and Python references.', example: 'Design an MCP server for our internal knowledge base.', requirements: 'Includes design references and evaluation scripts. Development needs Node.js or Python and an MCP SDK. Model evaluations and third-party APIs require user-provided credentials and may incur charges.' },
  { id: 'remotion', name: 'Remotion', category: 'design', description: 'Create programmatic videos with React, including animation, audio, captions and rendering.', example: 'Make a 20-second Remotion product video with captions and music.', requirements: 'Installs 12 official Remotion skills and references, not the runtime or renderer. Creating and rendering videos needs project dependencies, Node.js and a browser. The Remotion runtime has separate license terms.' },
]

export const SKILL_CONNECTORS: ConnectorDefinition[] = details.map(item => {
  const recipe = SKILL_RECIPES.find(recipe => recipe.id === item.id)!
  return {
    id: item.id, displayName: item.name, description: item.description, category: item.category,
    capabilities: [item.description], example: item.example, requirements: item.requirements,
    collection: 'tools', region: 'global', transport: 'skills', credentialMode: 'isolated',
    pluginId: `office-${item.id}@haha-connectors`, packageName: item.name, version: recipe.version,
    homepage: `https://github.com/${recipe.repository}/tree/${recipe.commit}`,
    platforms: ['darwin-arm64', 'darwin-x64', 'win32-x64', 'win32-arm64'],
  }
})

export function getSkillRecipe(id: string, version?: string): SkillBundleRecipe | undefined {
  return SKILL_RECIPES.find(recipe => recipe.id === id && (version === undefined || recipe.version === version))
}
