import dadaImage from '../../assets/agent-mascots/agent-mascot-code.png'
import huhuImage from '../../assets/agent-mascots/agent-mascot-plan.png'
import bubuImage from '../../assets/agent-mascots/agent-mascot-fix.png'
import huihuiImage from '../../assets/agent-mascots/agent-mascot-build.png'
import dadaSpritesheet from '../../assets/pets/dada-code/spritesheet.webp'
import huhuSpritesheet from '../../assets/pets/huhu-plan/spritesheet.webp'
import bubuSpritesheet from '../../assets/pets/bubu-fix/spritesheet.webp'
import huihuiSpritesheet from '../../assets/pets/huihui-build/spritesheet.webp'
import type { BuiltinPet } from './types'

export const BUILTIN_PETS = [
  {
    source: 'builtin',
    id: 'dada-code',
    displayName: 'Dada',
    description: 'A steady coding robot that helps build ideas one block at a time.',
    descriptionKey: 'settings.pets.builtin.dada',
    imageUrl: dadaImage,
    spriteVersionNumber: 2,
    spritesheetUrl: dadaSpritesheet,
    accent: '#4fd1b6',
  },
  {
    source: 'builtin',
    id: 'huhu-plan',
    displayName: 'Huhu',
    description: 'A pencil-and-notepad planning robot that maps a way through complex tasks.',
    descriptionKey: 'settings.pets.builtin.huhu',
    imageUrl: huhuImage,
    spriteVersionNumber: 2,
    spritesheetUrl: huhuSpritesheet,
    accent: '#6ea8ff',
  },
  {
    source: 'builtin',
    id: 'bubu-fix',
    displayName: 'Bubu',
    description: 'A wrench-carrying repair robot with a knack for spotting and fixing cracks.',
    descriptionKey: 'settings.pets.builtin.bubu',
    imageUrl: bubuImage,
    spriteVersionNumber: 2,
    spritesheetUrl: bubuSpritesheet,
    accent: '#ff9a76',
  },
  {
    source: 'builtin',
    id: 'huihui-build',
    displayName: 'Huihui',
    description: 'A gear-carrying build robot that perks up whenever a new reply arrives.',
    descriptionKey: 'settings.pets.builtin.huihui',
    imageUrl: huihuiImage,
    spriteVersionNumber: 2,
    spritesheetUrl: huihuiSpritesheet,
    accent: '#9b8cff',
  },
] as const satisfies readonly BuiltinPet[]

export function findBuiltinPet(id: string): BuiltinPet {
  return BUILTIN_PETS.find((pet) => pet.id === id) ?? BUILTIN_PETS[0]
}
