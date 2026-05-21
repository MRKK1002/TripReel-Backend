/**
 * Run once to create the first admin user:
 *   node scripts/createAdmin.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') })
const mongoose = require('mongoose')
const User = require('../models/User')

async function main() {
    await mongoose.connect(process.env.mongodburl)
    console.log('✅ Connected to MongoDB')

    const existing = await User.findOne({ email: 'admin@tripreel.com' })
    if (existing) {
        console.log('ℹ️  Admin already exists:', existing.email)
        process.exit(0)
    }

    const admin = await User.create({
        name: 'Admin',
        email: 'admin@tripreel.com',
        password: 'admin123',
        role: 'admin',
        status: 'Active',
    })

    console.log('✅ Admin created successfully!')
    console.log('   Email:   ', admin.email)
    console.log('   Password: admin123')
    console.log('   Role:    ', admin.role)
    process.exit(0)
}

main().catch(err => {
    console.error('❌ Error:', err.message)
    process.exit(1)
})
