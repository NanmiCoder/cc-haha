import AsyncStorage from '@react-native-async-storage/async-storage'
import { RecentSkillsRepository } from '../../core/recentSkills'

/** "Recently used" is stored on this phone and not synced with the computer. */
export const recentRepository = new RecentSkillsRepository(AsyncStorage)
