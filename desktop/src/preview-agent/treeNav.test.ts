import { describe, expect, it, beforeEach } from 'vitest'
import { climb, descend } from './treeNav'

beforeEach(() => { document.body.innerHTML = `<main><section><h1>A</h1></section></main>` })

describe('tree navigation', () => {
  it('climb returns parent element, not past body', () => {
    const h1 = document.querySelector('h1')!
    expect(climb(h1)?.tagName.toLowerCase()).toBe('section')
    expect(climb(document.querySelector('main')!)).toBeNull() // body is the boundary
  })
  it('descend returns first element child', () => {
    const section = document.querySelector('section')!
    expect(descend(section)?.tagName.toLowerCase()).toBe('h1')
    expect(descend(document.querySelector('h1')!)).toBeNull()
  })
})
