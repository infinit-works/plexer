--!strict
-- Reversible canvas mutation stack for undo and redo history operations.

local History = {}

export type Action = {
	label: string,
	apply: () -> (),
	revert: () -> (),
}

export type HistoryStack = {
	undoStack: { Action },
	redoStack: { Action },
	limit: number,
}

function History.create(maxDepth: number?): HistoryStack
	return {
		undoStack = {},
		redoStack = {},
		limit = maxDepth or 50,
	}
end

function History.push(stack: HistoryStack, action: Action)
	action.apply()
	table.insert(stack.undoStack, action)
	table.clear(stack.redoStack)
	if #stack.undoStack > stack.limit then
		table.remove(stack.undoStack, 1)
	end
end

function History.undo(stack: HistoryStack): boolean
	local action = table.remove(stack.undoStack)
	if not action then
		return false
	end
	action.revert()
	table.insert(stack.redoStack, action)
	return true
end

function History.redo(stack: HistoryStack): boolean
	local action = table.remove(stack.redoStack)
	if not action then
		return false
	end
	action.apply()
	table.insert(stack.undoStack, action)
	return true
end

return History
