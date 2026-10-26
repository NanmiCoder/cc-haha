import { expect,test } from 'bun:test'
import { MobileActivityClock } from './mobileActivityClock'
test('turn start remains stable while actual CLI progress advances; completed turns do not keep growing',()=>{
 let now=1000;const clock=new MobileActivityClock(()=>now)
 clock.start('a');now=2000;clock.progress('a')
 expect(clock.read('a')).toEqual({startedAt:1000,lastProgressAt:2000})
 now=3000;clock.finish('a');now=4000;clock.progress('a')
 expect(clock.read('a')).toEqual({startedAt:1000,lastProgressAt:3000,completedAt:3000})
 clock.start('a');expect(clock.read('a')).toEqual({startedAt:4000,lastProgressAt:4000})
})
test('unknown sessions do not invent timings and returned snapshots are immutable',()=>{
 const clock=new MobileActivityClock(()=>1);clock.progress('unknown');expect(clock.read('unknown')).toBeUndefined()
 clock.start('a');const snapshot=clock.read('a')!;snapshot.startedAt=0;expect(clock.read('a')?.startedAt).toBe(1)
 clock.clear();expect(clock.read('a')).toBeUndefined()
})
