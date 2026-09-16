import { fireEvent, render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { ComposerReferenceDetail } from './ComposerReferenceDetail'
it('shows the selected capability description without treating it as markup or invoking a task', () => {
  const close = vi.fn()
  render(<ComposerReferenceDetail mention={{kind:'plugin',id:'test@source',label:'Example',description:'<script>not markup</script>',path:'',isDirectory:false,tokenOrdinal:0,icon:'/connectors/hyperframes.svg'}} onClose={close} />)
  expect(screen.getByRole('dialog', {name:'Example'})).toBeTruthy()
  expect(screen.getByText('<script>not markup</script>')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', {name:'Close dialog'}))
  expect(close).toHaveBeenCalledOnce()
})
