import assert from 'node:assert/strict'
import test from 'node:test'
import ExcelJS from 'exceljs'
import { createParticipant, openDb } from '../db.ts'
import { exportWorkbook } from '../transfer.ts'

test('result workbook can be generated and reopened', async () => {
  const db = openDb(':memory:')
  createParticipant(db, {
    employeeNo: 'X001',
    name: '导出测试',
    department: '测试部',
    status: 'active',
    source: 'roster'
  })

  const buffer = await exportWorkbook(db)
  assert.equal(buffer.subarray(0, 2).toString(), 'PK')

  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(Uint8Array.from(buffer).buffer)
  assert.deepEqual(
    workbook.worksheets.map((sheet) => sheet.name),
    ['汇总', '参与人员', '中奖与领取', '红包流水', '答题明细']
  )
  assert.equal(workbook.getWorksheet('参与人员')?.getCell('A2').value, 'X001')
  db.close()
})
