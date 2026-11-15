--!strict
-- Reactive dependency graph for signals, derived computeds, and effect listeners.

local Graph = {}

export type Signal<T> = {
	get: (self: Signal<T>) -> T,
	set: (self: Signal<T>, value: T) -> (),
}

local activeObserver: (() -> ())? = nil

function Graph.signal<T>(initial: T): Signal<T>
	local current = initial
	local listeners: { () -> () } = {}

	local self = {} :: any
	function self.get(_self: Signal<T>): T
		if activeObserver then
			table.insert(listeners, activeObserver)
		end
		return current
	end

	function self.set(_self: Signal<T>, nextValue: T)
		if current == nextValue then
			return
		end
		current = nextValue
		for _, fn in listeners do
			fn()
		end
	end

	return self
end

function Graph.computed<T>(computeFn: () -> T): () -> T
	return function(): T
		return computeFn()
	end
end

function Graph.effect(callback: () -> ()): () -> ()
	local prev = activeObserver
	activeObserver = callback
	callback()
	activeObserver = prev
	return function() end
end

return Graph
