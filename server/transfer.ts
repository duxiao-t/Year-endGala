import ExcelJS from 'exceljs'
import type { Db } from './db.ts'
import { audit, createParticipant, getQuestions, toParticipant, upsertRosterParticipant } from './db.ts'
import { normalizeEmployeeNo } from './domain.ts'

function decodeBase64(value: string): Buffer {
  return Buffer.from(value.replace(/^data:.*;base64,/, ''), 'base64')
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (char === '"') {
      if (quoted && text[index + 1] === '"') {
        cell += '"'
        index += 1
      } else {
        quoted = !quoted
      }
    } else if (char === ',' && !quoted) {
      row.push(cell)
      cell = ''
    } else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && text[index + 1] === '\n') index += 1
      row.push(cell)
      if (row.some((value) => value.trim() !== '')) rows.push(row)
      row = []
      cell = ''
    } else {
      cell += char
    }
  }
  row.push(cell)
  if (row.some((value) => value.trim() !== '')) rows.push(row)
  return rows
}

async function readTable(
  filename: string,
  base64: string
): Promise<string[][]> {
  const buffer = decodeBase64(base64)
  if (filename.toLowerCase().endsWith('.csv')) {
    return parseCsv(buffer.toString('utf8').replace(/^\uFEFF/, ''))
  }
  const workbook = new ExcelJS.Workbook()
  const arrayBuffer = buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength
  ) as ArrayBuffer
  await workbook.xlsx.load(arrayBuffer)
  const sheet = workbook.worksheets[0]
  if (!sheet) return []
  const rows: string[][] = []
  sheet.eachRow((row) => {
    const values: string[] = []
    row.eachCell({ includeEmpty: true }, (cell) => {
      values.push(cell.text.trim())
    })
    if (values.some(Boolean)) rows.push(values)
  })
  return rows
}

function headerIndex(headers: string[], aliases: string[]): number {
  const normalized = headers.map((header) => header.trim().toLowerCase())
  for (const alias of aliases) {
    const index = normalized.indexOf(alias.toLowerCase())
    if (index >= 0) return index
  }
  return -1
}

export async function importParticipants(
  db: Db,
  filename: string,
  dataBase64: string
): Promise<{ imported: number; skipped: number }> {
  const rows = await readTable(filename, dataBase64)
  if (rows.length < 2) return { imported: 0, skipped: 0 }
  const headers = rows[0]
  const employeeIndex = headerIndex(headers, ['工号', 'employeeNo', 'employee_no', 'employee'])
  const nameIndex = headerIndex(headers, ['姓名', 'name'])
  const departmentIndex = headerIndex(headers, ['部门', 'department', 'dept'])
  if (employeeIndex < 0 || nameIndex < 0) {
    throw new Error('表格必须包含“工号”和“姓名”列')
  }
  let imported = 0
  let skipped = 0
  const transaction = db.transaction(() => {
    for (const row of rows.slice(1)) {
      const employeeNo = row[employeeIndex]?.trim()
      const name = row[nameIndex]?.trim()
      if (!employeeNo || !name) {
        skipped += 1
        continue
      }
      upsertRosterParticipant(db, {
        employeeNo,
        name,
        department: departmentIndex >= 0 ? row[departmentIndex]?.trim() : ''
      })
      imported += 1
    }
  })
  transaction()
  audit(db, 'admin', 'participants.import', JSON.stringify({ filename, imported, skipped }))
  return { imported, skipped }
}

export async function importQuestions(
  db: Db,
  filename: string,
  dataBase64: string
): Promise<{ imported: number; skipped: number }> {
  const rows = await readTable(filename, dataBase64)
  if (rows.length < 2) return { imported: 0, skipped: 0 }
  const headers = rows[0]
  const textIndex = headerIndex(headers, ['题目', 'question', 'text'])
  const indexes = ['A', 'B', 'C', 'D'].map((letter) =>
    headerIndex(headers, [letter, `选项${letter}`, `option${letter}`])
  )
  const correctIndex = headerIndex(headers, ['正确答案', '答案', 'correct', 'correctOption'])
  const durationIndex = headerIndex(headers, ['时长', 'duration', 'durationSec'])
  const pointsIndex = headerIndex(headers, ['分值', 'points'])
  if (textIndex < 0 || indexes.some((index) => index < 0) || correctIndex < 0) {
    throw new Error('题库需包含：题目、A、B、C、D、正确答案')
  }
  const maxSort = Number(
    (db.prepare('SELECT COALESCE(MAX(sort), 0) AS sort FROM questions').get() as { sort: number }).sort
  )
  let imported = 0
  let skipped = 0
  const insert = db.prepare(
    'INSERT INTO questions (sort, text, options, correct_option, duration_sec, points) VALUES (?, ?, ?, ?, ?, ?)'
  )
  const transaction = db.transaction(() => {
    rows.slice(1).forEach((row, offset) => {
      const text = row[textIndex]?.trim()
      const options = indexes.map((index) => row[index]?.trim())
      const correctRaw = row[correctIndex]?.trim().toUpperCase()
      if (!text || options.some((option) => !option)) {
        skipped += 1
        return
      }
      const correct = ['A', 'B', 'C', 'D'].indexOf(correctRaw)
      const numeric = Number(correctRaw)
      const correctOption =
        correct >= 0 ? correct : Number.isInteger(numeric) && numeric >= 1 && numeric <= 4 ? numeric - 1 : -1
      if (correctOption < 0) {
        skipped += 1
        return
      }
      insert.run(
        maxSort + offset + 1,
        text,
        JSON.stringify(options),
        correctOption,
        durationIndex >= 0 ? Math.max(5, Math.min(120, Number(row[durationIndex]) || 20)) : 20,
        pointsIndex >= 0 ? Math.max(1, Math.min(10_000, Number(row[pointsIndex]) || 100)) : 100
      )
      imported += 1
    })
  })
  transaction()
  audit(db, 'admin', 'questions.import', JSON.stringify({ filename, imported, skipped }))
  return { imported, skipped }
}

function addHeader(sheet: ExcelJS.Worksheet, columns: string[]) {
  const row = sheet.addRow(columns)
  row.font = { bold: true, color: { argb: 'FFFFFFFF' } }
  row.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FF0F766E' }
  }
  sheet.views = [{ state: 'frozen', ySplit: 1 }]
}

export async function exportWorkbook(db: Db): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'Year-end Gala'
  workbook.created = new Date()

  const summary = workbook.addWorksheet('汇总')
  addHeader(summary, ['指标', '值'])
  const stats = db
    .prepare(
      `SELECT COUNT(*) AS participants,
              SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active
       FROM participants`
    )
    .get() as { participants: number; active: number | null }
  const claims = db
    .prepare('SELECT COUNT(*) AS count, COALESCE(SUM(amount_fen), 0) AS amount FROM packet_claims')
    .get() as { count: number; amount: number }
  summary.addRow(['参与人数', stats.participants])
  summary.addRow(['有效参与人数', stats.active || 0])
  summary.addRow(['红包领取笔数', claims.count])
  summary.addRow(['红包金额合计（元）', (claims.amount / 100).toFixed(2)])
  summary.addRow(['导出时间', new Date().toISOString()])

  const participantSheet = workbook.addWorksheet('参与人员')
  addHeader(participantSheet, ['工号', '姓名', '部门', '状态', '来源', '登记时间'])
  const participantRows = db
    .prepare('SELECT * FROM participants ORDER BY employee_no')
    .all() as Array<{
    employee_no: string
    name: string
    department: string
    status: string
    source: string
    created_at: number
  }>
  participantRows.forEach((row) => {
    participantSheet.addRow([
      row.employee_no,
      row.name,
      row.department,
      row.status,
      row.source,
      new Date(row.created_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
    ])
  })

  const resultSheet = workbook.addWorksheet('中奖与领取')
  addHeader(resultSheet, ['玩法', '奖项', '排名', '工号', '姓名', '部门', '金额（元）', '时间', '状态'])
  const resultRows = db
    .prepare(
      `SELECT r.*, p.employee_no, p.name, p.department FROM results r
       JOIN participants p ON p.id = r.participant_id
       ORDER BY r.id DESC`
    )
    .all() as Array<{
    game: string
    prize_name: string
    rank: number
    employee_no: string
    name: string
    department: string
    amount_fen: number | null
    created_at: number
    voided: number
  }>
  resultRows.forEach((row) => {
    resultSheet.addRow([
      row.game,
      row.prize_name,
      row.rank,
      row.employee_no,
      row.name,
      row.department,
      row.amount_fen ? (row.amount_fen / 100).toFixed(2) : '',
      new Date(row.created_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
      row.voided ? '作废' : '有效'
    ])
  })

  const packetSheet = workbook.addWorksheet('红包流水')
  addHeader(packetSheet, ['工号', '姓名', '部门', '金额（元）', '兑付码', '领取时间', '兑付时间'])
  const packetRows = db
    .prepare(
      `SELECT c.*, p.employee_no, p.name, p.department FROM packet_claims c
       JOIN participants p ON p.id = c.participant_id ORDER BY c.id DESC`
    )
    .all() as Array<{
    employee_no: string
    name: string
    department: string
    amount_fen: number
    claim_code: string
    created_at: number
    redeemed_at: number | null
  }>
  packetRows.forEach((row) => {
    packetSheet.addRow([
      row.employee_no,
      row.name,
      row.department,
      (row.amount_fen / 100).toFixed(2),
      row.claim_code,
      new Date(row.created_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
      row.redeemed_at
        ? new Date(row.redeemed_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
        : ''
    ])
  })

  const quizSheet = workbook.addWorksheet('答题明细')
  addHeader(quizSheet, ['工号', '姓名', '题号', '选择', '是否正确', '得分', '作答时间'])
  const quizRows = db
    .prepare(
      `SELECT a.*, p.employee_no, p.name, q.text FROM quiz_answers a
       JOIN participants p ON p.id = a.participant_id
       JOIN questions q ON q.id = a.question_id
       ORDER BY a.answered_at DESC`
    )
    .all() as Array<{
    employee_no: string
    name: string
    question_id: number
    option_index: number
    correct: number
    score: number
    answered_at: number
  }>
  quizRows.forEach((row) => {
    quizSheet.addRow([
      row.employee_no,
      row.name,
      row.question_id,
      ['A', 'B', 'C', 'D'][row.option_index] || row.option_index + 1,
      row.correct ? '是' : '否',
      row.score,
      new Date(row.answered_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
    ])
  })

  const buffer = await workbook.xlsx.writeBuffer()
  return Buffer.from(buffer)
}

export function addParticipant(
  db: Db,
  input: { employeeNo: string; name: string; department?: string; status?: string }
) {
  const existing = db
    .prepare('SELECT id FROM participants WHERE employee_no = ?')
    .get(normalizeEmployeeNo(input.employeeNo)) as { id: number } | undefined
  if (existing) throw new Error('工号已存在')
  const id = createParticipant(db, {
    ...input,
    status: (input.status as 'active' | 'pending') || 'active',
    source: 'roster'
  })
  audit(db, 'admin', 'participant.create', String(id))
  return toParticipant(
    db.prepare('SELECT * FROM participants WHERE id = ?').get(id) as {
      id: number
      employee_no: string
      name: string
      department: string
      status: 'active'
      source: 'roster'
      created_at: number
    }
  )
}

export function addQuestion(
  db: Db,
  input: {
    text: string
    options: string[]
    correctOption: number
    durationSec?: number
    points?: number
  }
) {
  if (input.options.length !== 4 || input.options.some((option) => !option.trim())) {
    throw new Error('必须有四个非空选项')
  }
  if (input.correctOption < 0 || input.correctOption > 3) throw new Error('正确答案无效')
  const sort = Number(
    (db.prepare('SELECT COALESCE(MAX(sort), 0) AS sort FROM questions').get() as { sort: number }).sort
  )
  const result = db
    .prepare(
      'INSERT INTO questions (sort, text, options, correct_option, duration_sec, points) VALUES (?, ?, ?, ?, ?, ?)'
    )
    .run(
      sort + 1,
      input.text.trim(),
      JSON.stringify(input.options.map((option) => option.trim())),
      input.correctOption,
      Math.max(5, Math.min(120, input.durationSec || 20)),
      Math.max(1, Math.min(10_000, input.points || 100))
    )
  audit(db, 'admin', 'question.create', String(result.lastInsertRowid))
  return getQuestions(db).find((question) => question.id === Number(result.lastInsertRowid))
}
