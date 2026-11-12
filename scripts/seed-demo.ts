import { audit, openDb, upsertRosterParticipant } from '../server/db.ts'

const count = Math.max(1, Math.min(20_000, Number(process.argv[2] || 1000)))
const db = openDb()
let created = 0
const transaction = db.transaction(() => {
  for (let index = 1; index <= count; index += 1) {
    const employeeNo = `DEMO${String(index).padStart(4, '0')}`
    upsertRosterParticipant(db, {
      employeeNo,
      name: `演示员工${String(index).padStart(4, '0')}`,
      department: `第${(index % 12) + 1}组`
    })
    created += 1
  }
})
transaction()
audit(db, 'system', 'seed.demo', String(created))
db.close()
console.log(`Seeded ${created} demo participants. Join code: ${process.env.JOIN_CODE || '8888'}`)
