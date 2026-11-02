import AsyncStorage from '@react-native-async-storage/async-storage'
import { RecentSkillsRepository } from '../../core/recentSkills'

/** 「最近用过」存在这台手机上，不跟电脑同步。 */
export const recentRepository = new RecentSkillsRepository(AsyncStorage)
