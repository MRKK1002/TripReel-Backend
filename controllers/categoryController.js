const Category = require('../models/Category')

// GET /api/categories
exports.getAllCategories = async (req, res) => {
    try {
        const categories = await Category.find().sort({ createdAt: -1 })
        res.json({ success: true, count: categories.length, categories })
    } catch (err) {
        res.status(500).json({ success: false, message: err.message })
    }
}

// POST /api/categories
exports.createCategory = async (req, res) => {
    try {
        const category = await Category.create(req.body)
        res.status(201).json({ success: true, category })
    } catch (err) {
        res.status(400).json({ success: false, message: err.message })
    }
}

// PUT /api/categories/:id
exports.updateCategory = async (req, res) => {
    try {
        const category = await Category.findByIdAndUpdate(req.params.id, req.body, {
            new: true,
            runValidators: true,
        })
        if (!category) return res.status(404).json({ success: false, message: 'Category not found' })
        res.json({ success: true, category })
    } catch (err) {
        res.status(400).json({ success: false, message: err.message })
    }
}

// DELETE /api/categories/:id
exports.deleteCategory = async (req, res) => {
    try {
        const category = await Category.findByIdAndDelete(req.params.id)
        if (!category) return res.status(404).json({ success: false, message: 'Category not found' })
        res.json({ success: true, message: 'Category deleted successfully' })
    } catch (err) {
        res.status(500).json({ success: false, message: err.message })
    }
}
