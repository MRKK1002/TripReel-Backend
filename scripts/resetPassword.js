require('dotenv').config()
const mongoose = require('mongoose')
const User = require('../models/User')

const email = process.argv[2]
const newPassword = process.argv[3]

mongoose.connect(process.env.mongodburl).then(async () => {
  const user = await User.findOne({ email })
  if (!user) {
    console.error(`No user found: ${email}`)
    process.exit(1)
  }
  user.password = newPassword
  await user.save()
  console.log(`✅ Password reset for ${user.email}`)
  process.exit(0)
}).catch(err => { console.error(err); process.exit(1) })
