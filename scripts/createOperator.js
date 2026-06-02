require('dotenv').config()
const mongoose = require('mongoose')
const { Operator } = require('../models/Operator')

mongoose.connect(process.env.mongodburl).then(async () => {
  const existing = await Operator.findOne({ email: 'operator@tripreel.com' })
  if (existing) {
    console.log(`✅ Operator already exists: ${existing.email}`)
    process.exit(0)
  }

  const operator = await Operator.create({
    contactName: 'Test Operator',
    email: 'operator@tripreel.com',
    phone: '9876543210',
    password: 'operator123',
    onboardingState: 'DRAFT',
  })

  console.log(`✅ Created operator: ${operator.email}`)
  process.exit(0)
}).catch(err => {
  console.error(err)
  process.exit(1)
})
