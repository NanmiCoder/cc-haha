import { describe, expect, it, beforeEach } from 'vitest'
import { applyEdit, canEditText, readElementText, writeElementText } from './popover'

beforeEach(() => { document.body.innerHTML = `<h1 id="t" style="color:rgb(0,0,0)">Old</h1>` })

describe('applyEdit', () => {
  it('applies text + color to the live DOM and returns a diff', () => {
    const el = document.getElementById('t')!
    const diff = applyEdit(el, { text: 'New', color: 'rgb(255,0,0)' })
    expect(el.textContent).toBe('New')
    expect(el.style.color).toBe('rgb(255, 0, 0)')
    expect(diff.text).toEqual({ from: 'Old', to: 'New' })
    expect(diff.color?.to).toBe('rgb(255,0,0)')
  })

  it('writes opacity 0 as a valid value (not swallowed by a falsy check)', () => {
    const el = document.getElementById('t')!
    const diff = applyEdit(el, { opacity: '0' })
    expect(el.style.opacity).toBe('0')
    expect(diff.opacity?.to).toBe('0')
  })

  it('edits a form control\'s text through value, not textContent', () => {
    document.body.innerHTML = '<input id="f" value="Old value">'
    const field = document.getElementById('f') as HTMLInputElement
    const diff = applyEdit(field, { text: 'New value' })
    expect(field.value).toBe('New value')
    expect(diff.text).toEqual({ from: 'Old value', to: 'New value' })
  })
})

describe('readElementText / writeElementText', () => {
  it('reads and writes value for form controls and textContent for other elements', () => {
    document.body.innerHTML = '<input id="f" value="v"><p id="p">t</p>'
    const field = document.getElementById('f') as HTMLInputElement
    const paragraph = document.getElementById('p')!
    expect(readElementText(field)).toBe('v')
    expect(readElementText(paragraph)).toBe('t')

    writeElementText(field, 'v2')
    writeElementText(paragraph, 't2')
    expect(field.value).toBe('v2')
    expect(paragraph.textContent).toBe('t2')
  })
})

describe('canEditText', () => {
  it('allows form controls and childless nodes, not containers (to avoid flattening the subtree)', () => {
    document.body.innerHTML = '<input id="f"><p id="p">t</p><div id="d"><span>a</span></div>'
    expect(canEditText(document.getElementById('f')!)).toBe(true)
    expect(canEditText(document.getElementById('p')!)).toBe(true)
    expect(canEditText(document.getElementById('d')!)).toBe(false)
  })
})
