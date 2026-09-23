local Constants = require(script.Parent.Parent.Utils.Constants)

local InstanceTracker = {}
InstanceTracker.__index = InstanceTracker

function InstanceTracker.new(onStudioChangeCallback)
	local self = setmetatable({
		_connections = {},  -- inst → { conn1, conn2, ... }
		_cachedPaths = {},  -- inst → "Service/Folder/Script"
		OnStudioChange = onStudioChangeCallback,
	}, InstanceTracker)
	return self
end

--------------------------------------------------------------------------------
-- Path resolution with cache (Phase 1 - Bug #1 fix)
--------------------------------------------------------------------------------
function InstanceTracker:GetRelativePath(instance)
	if not instance then return "" end

	-- If parent is nil (being destroyed), return cached path
	if not instance:IsDescendantOf(game) then
		return self._cachedPaths[instance] or ""
	end

	-- Build path from scratch
	local parts = {}
	local current = instance
	while current and current ~= game do
		table.insert(parts, 1, current.Name)
		current = current.Parent
	end

	local pathStr = table.concat(parts, "/")
	self._cachedPaths[instance] = pathStr
	return pathStr
end

-- Refresh cached paths for an instance and all its descendants
function InstanceTracker:RefreshPathCache(inst)
	if not inst or not inst:IsDescendantOf(game) then return end
	self._cachedPaths[inst] = self:GetRelativePath(inst)
	for _, desc in ipairs(inst:GetDescendants()) do
		if self._connections[desc] then
			self._cachedPaths[desc] = self:GetRelativePath(desc)
		end
	end
end

--------------------------------------------------------------------------------
-- Tracking
--------------------------------------------------------------------------------
function InstanceTracker:Track(inst)
	if self._connections[inst] then return end
	self._cachedPaths[inst] = self:GetRelativePath(inst)

	local conns = {}

	-- Listen for Name changes (rename)
	table.insert(conns, inst:GetPropertyChangedSignal("Name"):Connect(function()
		local oldPath = self._cachedPaths[inst]
		self:RefreshPathCache(inst) -- refresh self + all descendants
		if self.OnStudioChange then
			self.OnStudioChange("Renamed", inst, "Name", oldPath)
		end
	end))

	-- Listen for Parent changes (move)
	table.insert(conns, inst:GetPropertyChangedSignal("Parent"):Connect(function()
		local oldPath = self._cachedPaths[inst]
		if inst.Parent and inst:IsDescendantOf(game) then
			self:RefreshPathCache(inst)
			if self.OnStudioChange then
				self.OnStudioChange("Renamed", inst, "Parent", oldPath)
			end
		end
	end))

	-- Listen for Source changes on scripts
	if inst:IsA("LuaSourceContainer") then
		table.insert(conns, inst:GetPropertyChangedSignal("Source"):Connect(function()
			if self.OnStudioChange then
				self.OnStudioChange("Changed", inst, "Source")
			end
		end))
	end

	-- Listen for Value changes on value types
	if inst:IsA("ValueBase") then
		table.insert(conns, inst:GetPropertyChangedSignal("Value"):Connect(function()
			if self.OnStudioChange then
				self.OnStudioChange("Changed", inst, "Value")
			end
		end))
	end

	self._connections[inst] = conns

	-- Track all descendants recursively
	for _, child in ipairs(inst:GetDescendants()) do
		self:Track(child)
	end
end

function InstanceTracker:Untrack(inst)
	if self._connections[inst] then
		for _, conn in ipairs(self._connections[inst]) do
			conn:Disconnect()
		end
		self._connections[inst] = nil
	end
	-- Keep cached path for a moment so deletion can read it
	task.delay(Constants.ECHO_TTL, function()
		self._cachedPaths[inst] = nil
	end)

	for _, child in ipairs(inst:GetDescendants()) do
		self:Untrack(child)
	end
end

-- Generate a checksum for a script's source (Phase 4 - #7)
function InstanceTracker:GetChecksum(instance)
	if not instance then return nil end
	if instance:IsA("LuaSourceContainer") then
		local src = instance.Source or ""
		-- Simple DJB2 hash
		local hash = 5381
		for i = 1, #src do
			hash = ((hash * 33) + string.byte(src, i)) % 2147483647
		end
		return tostring(hash)
	elseif instance:IsA("ValueBase") then
		return tostring(instance.Value)
	end
	return nil
end

return InstanceTracker
