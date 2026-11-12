import assert from 'node:assert/strict'
import test from 'node:test'
import type { EventSettings } from '../../shared/types.ts'
import {
  createParticipant,
  getQuestions,
  getSettings,
  openDb,
  saveSettings
} from '../db.ts'
import {
  answerQuiz,
  buildSnapshot,
  claimRedPacket,
  drawLottery,
  finishRedPacket,
  finishShake,
  getView,
  startQuiz,
  startRedPacket,
  startShake,
  submitShakeBatch
} from '../state.ts'

function createPeople(count: number) {
  const db = openDb(':memory:')
  const ids: number[] = []
  for (let index = 1; index <= count; index += 1) {
    ids.push(
      createParticipant(db, {
        employeeNo: `T${index}`,
        name: `测试${index}`,
        department: '测试组',
        status: 'active',
        source: 'roster'
      })
    )
  }
  return { db, ids }
}

test('game flow persists winners and never duplicates a lottery winner', async () => {
  const { db, ids } = createPeople(8)
  startShake(db)
  assert.equal(getView(db), 'shake')
  assert.equal(submitShakeBatch(db, ids[0], 3).ok, true)
  assert.equal(submitShakeBatch(db, ids[1], 5).ok, true)
  assert.equal(finishShake(db), true)
  const afterShake = buildSnapshot(db)
  assert.equal(afterShake.shake.winners[0].participantId, ids[1])

  startRedPacket(db)
  const first = claimRedPacket(db, ids[2], 'test-request-1')
  assert.equal(first.ok, true)
  assert.ok((first.amountFen || 0) > 0)
  assert.equal(claimRedPacket(db, ids[2], 'test-request-1').ok, true)
  await new Promise((resolve) => setTimeout(resolve, 300))
  const second = claimRedPacket(db, ids[2], 'test-request-2')
  assert.equal(second.ok, true)
  await new Promise((resolve) => setTimeout(resolve, 300))
  const limited = claimRedPacket(db, ids[2], 'test-request-3')
  assert.equal(limited.ok, false)
  assert.equal(limited.reason, 'limit')
  finishRedPacket(db)

  startQuiz(db)
  const question = getQuestions(db)[0]
  const answer = answerQuiz(db, ids[3], question.correctOption)
  assert.equal(answer.ok, true)
  assert.equal(answer.correct, true)
  assert.equal(answerQuiz(db, ids[3], question.correctOption).ok, false)
  const quizSnapshot = buildSnapshot(db)
  assert.equal(quizSnapshot.quiz.phase, 'question')
  assert.equal(quizSnapshot.quiz.answeredCount, 1)
  const result = drawLottery(db, 0, 2)
  assert.equal(result.ok, true)
  assert.equal(new Set(result.winners?.map((winner) => winner.participantId)).size, 2)
  const lotterySnapshot = buildSnapshot(db)
  assert.equal(lotterySnapshot.lottery.lastDraw?.winners.length, 2)
  db.close()
})

test('eligibility policy excludes game winners only when configured', () => {
  const { db, ids } = createPeople(10)
  startShake(db)
  submitShakeBatch(db, ids[0], 4)
  finishShake(db)
  const settings = getSettings(db)
  saveSettings(db, {
    ...settings,
    eligibilityPolicy: 'exclude_game_winners_from_lottery'
  } as EventSettings)
  const draw = drawLottery(db, 0, 5)
  assert.equal(draw.ok, true)
  assert.equal(draw.winners?.some((winner) => winner.participantId === ids[0]), false)
  db.close()
})
