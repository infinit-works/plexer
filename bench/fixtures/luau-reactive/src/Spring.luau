--!strict
-- Harmonic spring velocity and damping interpolation stepper.

local Graph = require(script.Parent.Graph)

local Spring = {}

export type SpringState = {
	position: number,
	velocity: number,
	target: number,
	stiffness: number,
	damping: number,
}

function Spring.new(initial: number, stiffness: number?, damping: number?): SpringState
	return {
		position = initial,
		velocity = 0,
		target = initial,
		stiffness = stiffness or 180,
		damping = damping or 22,
	}
end

function Spring.step(state: SpringState, dt: number): number
	local displacement = state.position - state.target
	local accel = -state.stiffness * displacement - state.damping * state.velocity
	state.velocity += accel * dt
	state.position += state.velocity * dt
	return state.position
end

function Spring.bindTarget(source: Graph.Signal<number>): SpringState
	return Spring.new(source:get())
end

return Spring
