import '@testing-library/jest-dom'
import { render, fireEvent } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { ImageBlockGallery, type ImageBlock } from './ToolCallBlock'

const singleImage: ImageBlock[] = [
  { src: 'https://example.com/img1.png', mimeType: 'image/png' },
]

const multipleImages: ImageBlock[] = [
  { src: 'https://example.com/img1.png', mimeType: 'image/png' },
  { src: 'https://example.com/img2.png', mimeType: 'image/png' },
  { src: 'https://example.com/img3.png', mimeType: 'image/png' },
]

/** Get the main (large) image inside the modal overlay. */
function getModalMainImage(container: HTMLElement): HTMLImageElement | null {
  // The modal renders inside a [role=dialog] or a fixed overlay with max-h-[70vh]
  const modalImg = container.querySelector('.max-h-\\[70vh\\] img') as HTMLImageElement | null
  return modalImg
}

describe('ImageBlockGallery', () => {
  it('renders images in a grid with correct count label', () => {
    const { container } = render(<ImageBlockGallery imageBlocks={multipleImages} />)
    const images = container.querySelectorAll('img')
    expect(images).toHaveLength(3)
    expect(container.textContent).toContain('3 images')
  })

  it('renders single image with singular label', () => {
    const { container } = render(<ImageBlockGallery imageBlocks={singleImage} />)
    const images = container.querySelectorAll('img')
    expect(images).toHaveLength(1)
    expect(container.textContent).toContain('1 image')
    expect(container.textContent).not.toContain('1 images')
  })

  it('uses 2-column grid for multiple images', () => {
    const { container } = render(<ImageBlockGallery imageBlocks={multipleImages} />)
    const grid = container.querySelector('.grid-cols-2')
    expect(grid).toBeInTheDocument()
  })

  it('uses 1-column grid for single image', () => {
    const { container } = render(<ImageBlockGallery imageBlocks={singleImage} />)
    const grid = container.querySelector('.grid-cols-1')
    expect(grid).toBeInTheDocument()
    expect(container.querySelector('.grid-cols-2')).not.toBeInTheDocument()
  })

  it('opens fullscreen modal on image click', () => {
    const { container, baseElement } = render(<ImageBlockGallery imageBlocks={multipleImages} />)

    // Click the first image button
    const buttons = container.querySelectorAll('button[type="button"]')
    expect(buttons.length).toBe(3)
    fireEvent.click(buttons[0]!)

    // Modal should now be open — find the large main image
    const modalImg = getModalMainImage(baseElement)
    expect(modalImg).toBeInTheDocument()
    expect(modalImg!.src).toBe('https://example.com/img1.png')
  })

  it('supports left/right keyboard navigation in modal', () => {
    const { container, baseElement } = render(<ImageBlockGallery imageBlocks={multipleImages} />)

    // Open modal on first image
    const buttons = container.querySelectorAll('button[type="button"]')
    fireEvent.click(buttons[0]!)

    // Press right arrow to go to second image
    fireEvent.keyDown(document, { key: 'ArrowRight' })
    let modalImg = getModalMainImage(baseElement)
    expect(modalImg!.src).toBe('https://example.com/img2.png')

    // Press right arrow again to go to third image
    fireEvent.keyDown(document, { key: 'ArrowRight' })
    modalImg = getModalMainImage(baseElement)
    expect(modalImg!.src).toBe('https://example.com/img3.png')

    // Press left arrow to go back to second image
    fireEvent.keyDown(document, { key: 'ArrowLeft' })
    modalImg = getModalMainImage(baseElement)
    expect(modalImg!.src).toBe('https://example.com/img2.png')
  })

  it('wraps around when navigating past last/first image', () => {
    const { container, baseElement } = render(<ImageBlockGallery imageBlocks={multipleImages} />)

    // Open modal on last image (index 2)
    const buttons = container.querySelectorAll('button[type="button"]')
    fireEvent.click(buttons[2]!)

    let modalImg = getModalMainImage(baseElement)
    expect(modalImg!.src).toBe('https://example.com/img3.png')

    // Press right arrow — should wrap to first image
    fireEvent.keyDown(document, { key: 'ArrowRight' })
    modalImg = getModalMainImage(baseElement)
    expect(modalImg!.src).toBe('https://example.com/img1.png')
  })
})
