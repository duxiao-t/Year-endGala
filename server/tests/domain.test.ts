import assert from 'node:assert/strict'
import test from 'node:test'
import {
  isRedPacketConfigValid,
  maskName,
  nextRedPacketAmount,
  shuffle,
  speedScore
} from '../domain.ts'
import type { RedPacketSettings } from '../../shared/types.ts'

const randomConfig: RedPacketSettings = {
  durationSec: 20,
  mode: 'random',
  budgetFen: 1000,
  packetCount: 5,
  fixedFen: 200,
  minFen: 100,
  maxFen: 400,
  maxClaims: 2,
  prizeName: '红包'
}

test('random red packets preserve total budget and bounds', () => {
  let spent = 0
  for (let index = 0; index < randomConfig.packetCount; index += 1) {
    const amount = nextRedPacketAmount({
      config: randomConfig,
      spentFen: spent,
      claimedCount: index
    })
    assert.ok(amount !== null)
    assert.ok(amount >= randomConfig.minFen)
    assert.ok(amount <= randomConfig.maxFen)
    spent += amount
  }
  assert.equal(spent, randomConfig.budgetFen)
})

test('invalid red packet configurations are rejected', () => {
  assert.equal(isRedPacketConfigValid(randomConfig), true)
  assert.equal(isRedPacketConfigValid({ ...randomConfig, packetCount: 0 }), false)
  assert.equal(isRedPacketConfigValid({ ...randomConfig, budgetFen: 100 }), false)
  assert.equal(
    isRedPacketConfigValid({ ...randomConfig, mode: 'fixed', budgetFen: 999 }),
    false
  )
})

test('shuffle is deterministic-free and keeps every item', () => {
  const input = Array.from({ length: 100 }, (_, index) => index)
  const output = shuffle(input)
  assert.deepEqual([...output].sort((a, b) => a - b), input)
  assert.deepEqual(input, Array.from({ length: 100 }, (_, index) => index))
})

test('name masking and speed score are bounded', () => {
  assert.equal(maskName('张三'), '张*')
  assert.equal(maskName('欧阳娜娜'), '欧**')
  const end = 20_000
  assert.equal(speedScore({ basePoints: 100, speedBonusMax: 50 }, end, 20, 0), 150)
  assert.equal(speedScore({ basePoints: 100, speedBonusMax: 50 }, end, 20, end), 100)
})
