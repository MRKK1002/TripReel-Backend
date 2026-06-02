require('dotenv').config()
const mongoose = require('mongoose')
const User = require('../models/User')

mongoose.connect(process.env.mongodburl).then(async () => {
  const existing = await User.findOne({ email: 'admin@triplreel.com' })
  if (existing) {
    // Just update role
    existing.role = 'admin'
    await existing.save()
    console.log(`✅ Updated existing user to admin: ${existing.email}`)
  } else {
    const user = await User.create({
      name: 'Admin',
      email: 'admin@triplreel.com',
      password: 'admin123',
      role: 'admin',
    })
    console.log(`✅ Created admin user: ${user.email}`)
  }
  process.exit(0)
}).catch(err => {
  console.error(err)
  process.exit(1)
})
