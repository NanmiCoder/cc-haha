import { registerBundledSkill } from '../bundledSkills.js'

const PDF_PROMPT = `# /pdf — read, validate, or generate PDFs where layout matters

Use this skill when the user wants to inspect a PDF whose visual layout matters (contracts, invoices, slide decks, scanned documents), or when you need to *produce* a PDF and verify that it actually renders the way you intended. Pure text extraction (no layout) doesn't need this skill — \`Read\` or \`Bash\` with \`pdftotext\` is enough.

## When to use

- "Read this contract / invoice / brochure / slide deck and …"
- "Generate a PDF report / cover letter / receipt that looks like …"
- "Why is the third page in this PDF cut off?"
- "Is the rendered output what I asked for?" (visual review)

## When NOT to use

- Plain text dumps from a PDF → \`pdftotext file.pdf -\` via Bash, then Read the output
- Filling a form via the web → \`mcp__chrome-devtools__*\` against the page
- Designing UI mockups → Pencil / Figma MCP

## Core principle: render and look

Layout fidelity cannot be judged from text extraction. To verify a PDF (yours or theirs), **render its pages to PNGs and look at them**. Adopt this loop:

1. Generate or modify the PDF
2. Render the changed pages to PNG
3. View the PNG (Read the image, or use \`mcp__computer-use__screenshot\` if it's open in a viewer)
4. Adjust, repeat

Skipping the render step is the #1 source of "it looked fine in my head" PDF bugs.

## Tool inventory (preferred → fallback)

### Rendering pages to PNG
- \`pdftoppm -r 150 input.pdf output_prefix\` — Poppler, available cross-platform via:
  - macOS: \`brew install poppler\`
  - Debian/Ubuntu: \`apt-get install poppler-utils\`
  - Windows: \`choco install poppler\` or download Poppler binaries
- Resolution 150 DPI is enough for review; bump to 300 only if you need to read fine print

### Extracting text (no layout fidelity)
- \`pdftotext -layout input.pdf -\` — quick, preserves columns reasonably
- Python \`pypdf\` or \`pdfplumber\` if you need structured access (tables, bounding boxes)

### Generating PDFs
- **Python**: \`reportlab\` (programmatic, code-first), \`weasyprint\` (HTML/CSS → PDF, best when you already think in CSS)
- **Node**: \`pdfkit\` (programmatic), \`puppeteer\` + \`page.pdf()\` (HTML → PDF, full Chromium)
- **CLI / quick**: \`pandoc input.md -o output.pdf\` (needs LaTeX or wkhtmltopdf)

Pick by what the user *already has* — don't drag in a new toolchain unless asked.

## File conventions

- Intermediates (renderings, work-in-progress files): \`tmp/pdfs/\` (create if missing, clean up at the end)
- Final artifacts the user will keep: \`output/pdf/<descriptive-name>.pdf\`
- Use stable, descriptive names — never \`final_v3_FINAL.pdf\` or random hashes

## Quality bar (visual review)

When you generate a PDF, before declaring done, render and check for:
- **Text clipping** at page edges and inside tables
- **Overlapping** elements (tables that bleed into the next column, footers crashing into body)
- **Broken pagination** (orphan headings, widow lines, header on a page with no body)
- **Font issues** (missing glyphs as boxes, wrong typeface, inconsistent sizes)
- **Hyphens vs em/en dashes** — generators that auto-convert often produce typographic dashes where ASCII hyphens are expected (especially in code samples and URLs)
- **Images** rendered (not blank) and not pixelated
- **Citations / footnotes** legible and pointing to the right anchors

Re-render after every meaningful change. A PDF that passes a visual review on page 1 can break on page 7 because content shifted.

## What to deliver

When you finish, tell the user:
1. Final file path
2. Page count
3. What you visually verified (which pages you reviewed and what you checked)
4. Any caveats you couldn't verify (e.g., "I didn't render page 12 because it's a binary attachment")

Then clean up \`tmp/pdfs/\` if it's no longer needed.
`

export function registerPdfSkill(): void {
  registerBundledSkill({
    name: 'pdf',
    description:
      'Read, validate, or generate PDFs with layout fidelity — render pages to PNG and visually review.',
    userInvocable: true,
    async getPromptForCommand(args) {
      let prompt = PDF_PROMPT
      if (args) {
        prompt += `\n\n## User-provided context\n\n${args}`
      }
      return [{ type: 'text', text: prompt }]
    },
  })
}
