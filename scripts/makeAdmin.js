require('dotenv').config()
const mongoose = require('mongoose')
const User = require('../models/User')

const email = process.argv[2]

if (!email) {
  console.error('Usage: node scripts/makeAdmin.js <email>')
  process.exit(1)
}

mongoose.connect(process.env.mongodburl).then(async () => {
  const user = await User.findOneAndUpdate(
    { email },
    { $set: { role: 'admin' } },
    { new: true }
  )
  if (!user) {
    console.error(`No user found with email: ${email}`)
  } else {
    console.log(`✅ ${user.email} is now role: ${user.role}`)
  }
  process.exit(0)
}).catch(err => {
  console.error(err)
  process.exit(1)
})
