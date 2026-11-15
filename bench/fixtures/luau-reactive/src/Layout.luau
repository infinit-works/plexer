--!strict
-- Responsive viewport breakpoint scale and padding rules for UI frames.

local Graph = require(script.Parent.Graph)

local Layout = {}

function Layout.computeScale(viewportWidth: number): number
	if viewportWidth < 640 then
		return 0.75
	elseif viewportWidth < 1280 then
		return 1.0
	end
	return 1.25
end

function Layout.bindViewportScale(widthSignal: Graph.Signal<number>): () -> number
	return Graph.computed(function(): number
		return Layout.computeScale(widthSignal:get())
	end)
end

return Layout
