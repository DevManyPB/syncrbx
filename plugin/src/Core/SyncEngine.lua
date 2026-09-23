local Constants = require(script.Parent.Parent.Utils.Constants)
local InstanceTracker = require(script.Parent.InstanceTracker)
local ChangeHistoryService = game:GetService("ChangeHistoryService")

local SyncEngine = {}
SyncEngine.__index = SyncEngine

--------------------------------------------------------------------------------
-- Helpers
--------------------------------------------------------------------------------

-- Value types that JSON cannot encode directly are converted to tables.
local function serializeValue(instance)
	if instance:IsA("Color3Value") then
		local c = instance.Value
		return { R = c.R, G = c.G, B = c.B }
	end
	return instance.Value
end

local function deserializeValue(instance, value)
	if instance:IsA("Color3Value") and type(value) == "table" then
		return Color3.new(value.R or value[1] or 0, value.G or value[2] or 0, value.B or value[3] or 0)
	end
	return value
end

-- True when every descendant is something SyncRbx manages, so destroying the
-- instance cannot take Parts, Models or other user content with it.
local function hasOnlySyncableDescendants(instance)
	for _, descendant in ipairs(instance:GetDescendants()) do
		if not Constants.isSyncableClass(descendant.ClassName) then
			return false
		end
	end
	return true
end

local function hasSyncableDescendant(instance)
	for _, descendant in ipairs(instance:GetDescendants()) do
		if Constants.isSyncableClass(descendant.ClassName) then
			return true
		end
	end
	return false
end

--------------------------------------------------------------------------------
-- Constructor
--------------------------------------------------------------------------------
function SyncEngine.new(net, logger, uiWidget)
	local self = setmetatable({
		_net = net,
		_logger = logger,
		_ui = uiWidget,

		-- State machine (Phase 3 - #11)
		_state = Constants.State.DISCONNECTED,
		_watchOnly = false, -- Phase 3 - #12

		ProjectName = "?",
		SyncedFiles = 0,
		SyncedServices = 0,

		_recentServerChanges = {},
		_pendingStudioChanges = {},
		_pendingChangesMap = {},
		_debounceThread = nil,
		_mainLoopThread = nil,
		_pendingCount = 0, -- Phase 3 - #10

		-- While > 0, Studio changes are the plugin's own writes and are not sent
		-- back to disk. Decremented with task.defer so deferred signals fired by
		-- those writes are still suppressed.
		_applyDepth = 0,
		_recentRemovals = {},
		_massDeleteWarned = false,
		_duplicateWarned = {},
	}, SyncEngine)

	self._tracker = InstanceTracker.new(function(action, instance, propName, oldPath)
		self:_sendStudioChange(action, instance, propName, oldPath)
	end)

	-- Every service the user can choose is watched; changes outside the chosen
	-- ones are dropped in _sendStudioChange.
	self.RootServices = {}
	for _, serviceName in ipairs(Constants.SELECTABLE_SERVICES) do
		local ok, service = pcall(function() return game:GetService(serviceName) end)
		if ok and service then
			table.insert(self.RootServices, service)
		end
	end

	-- Set of synced service names, from the project's syncrbx.project.json.
	-- nil = older server without service selection: everything is synced.
	self._allowedServices = nil

	self:_setupUI()
	self:_setupCleanupLoop()
	self:_setupServerProbe()

	return self
end

--------------------------------------------------------------------------------
-- State Machine (Phase 3 - #11)
--------------------------------------------------------------------------------
function SyncEngine:GetState()
	return self._state
end

function SyncEngine:_setState(newState)
	local oldState = self._state
	if oldState == newState then return end
	self._state = newState
	self._logger:Log(
		string.format("State: %s → %s", oldState, newState),
		Constants.Colors.CYAN
	)
	self:_updateUI()
end

function SyncEngine:IsConnected()
	return self._state == Constants.State.CONNECTED
		or self._state == Constants.State.WATCH_ONLY
end

function SyncEngine:IsSyncing()
	return self._state == Constants.State.SYNCING
end

--------------------------------------------------------------------------------
-- UI Integration
--------------------------------------------------------------------------------
function SyncEngine:_setupUI()
	self._ui.ForceSyncBtn.MouseButton1Click:Connect(function()
		self:ForceSync()
	end)

	self._ui.PauseBtn.MouseButton1Click:Connect(function()
		self:ToggleConnection()
	end)

	self._ui.ExportBtn.MouseButton1Click:Connect(function()
		self:ExportAll()
	end)

	-- Watch-Only toggle (Phase 3 - #12)
	if self._ui.WatchOnlyBtn then
		self._ui.WatchOnlyBtn.MouseButton1Click:Connect(function()
			self:ToggleWatchOnly()
		end)
	end

	if self._ui.ServicesBtn then
		self._ui.ServicesBtn.MouseButton1Click:Connect(function()
			self:EditServices()
		end)
	end
end

--------------------------------------------------------------------------------
-- Synced services
--------------------------------------------------------------------------------
function SyncEngine:_setServices(serviceList)
	if type(serviceList) ~= "table" then
		self._allowedServices = nil
		self._ui:SetServices(nil)
		return
	end
	local set = {}
	for _, name in ipairs(serviceList) do
		set[name] = true
	end
	self._allowedServices = set
	self._ui:SetServices(serviceList)
end

function SyncEngine:_reportServer(success, pingData)
	if success and type(pingData) == "table" then
		self._ui:SetServerInfo({
			found = true,
			project = pingData.project,
			configured = pingData.configured ~= false,
		})
	else
		self._ui:SetServerInfo({ found = false })
	end
end

-- While disconnected and the panel is open, checks every few seconds whether
-- `syncrbx serve` is running, so the panel can say what to do next.
function SyncEngine:_setupServerProbe()
	task.spawn(function()
		while true do
			if self._state == Constants.State.DISCONNECTED and self._ui.Widget.Enabled then
				local success, pingData = self._net:Ping()
				if self._state == Constants.State.DISCONNECTED then
					self:_reportServer(success, pingData)
				end
			end
			task.wait(4)
		end
	end)
end

function SyncEngine:_isServiceAllowed(serviceName)
	return self._allowedServices == nil or self._allowedServices[serviceName] == true
end

-- "Workspace/Map/Door" → is Workspace synced?
function SyncEngine:_isPathAllowed(instancePath)
	local serviceName = string.split(instancePath or "", "/")[1]
	return self:_isServiceAllowed(serviceName)
end

-- Services that already contain scripts in this place (pre-checked in the picker)
function SyncEngine:_servicesWithScripts()
	local found = {}
	for _, service in ipairs(self.RootServices) do
		for _, descendant in ipairs(service:GetDescendants()) do
			if descendant:IsA("LuaSourceContainer") then
				found[service.Name] = true
				break
			end
		end
	end
	return found
end

-- Shows the picker and saves the choice on the server. `done(ok)` is called
-- with true once the services are saved.
function SyncEngine:_promptServices(currentServices, isFirstTime, done)
	local withScripts = self:_servicesWithScripts()
	local selected, hints = {}, {}
	for _, name in ipairs(Constants.SELECTABLE_SERVICES) do
		if withScripts[name] then
			hints[name] = "has scripts"
		end
	end
	if currentServices then
		for _, name in ipairs(currentServices) do
			selected[name] = true
		end
	else
		for name in pairs(Constants.DEFAULT_SERVICES) do
			selected[name] = true
		end
		for name in pairs(withScripts) do
			selected[name] = true
		end
	end

	self._ui:ShowServicePicker({
		services = Constants.SELECTABLE_SERVICES,
		selected = selected,
		hints = hints,
		isFirstTime = isFirstTime,
		onConfirm = function(chosen)
			local ok, response = self._net:Post("/config", { services = chosen })
			local saved = false
			if ok then
				local decoded, data = pcall(function() return game:GetService("HttpService"):JSONDecode(response) end)
				saved = decoded and type(data) == "table" and data.success == true
			end
			if not saved then
				self._logger:Log("Could not save the services on the server", Constants.Colors.RED)
				done(false)
				return
			end
			self:_setServices(chosen)
			self._logger:Log("Syncing: " .. table.concat(chosen, ", "), Constants.Colors.GREEN)
			done(true)
		end,
		onCancel = function()
			done(false)
		end,
	})
end

-- "Services" button: change which services are synced
function SyncEngine:EditServices()
	local success, pingData = self._net:Ping()
	if not success then
		self._logger:Log("Server not found. Run 'syncrbx serve' first.", Constants.Colors.RED)
		return
	end
	if pingData.configured == nil then
		self._logger:Log("This SyncRbx server is too old to choose services. Update the CLI.", Constants.Colors.ORANGE)
		return
	end

	local previous = self._allowedServices or {}
	self:_promptServices(pingData.services, pingData.configured == false, function(ok)
		if not ok or not self:IsConnected() then return end
		local added = {}
		for name in pairs(self._allowedServices or {}) do
			if not previous[name] then
				table.insert(added, name)
			end
		end
		if #added > 0 then
			self._logger:Log("Added " .. table.concat(added, ", ") .. ". Use 'Export' to save their existing scripts to disk.", Constants.Colors.CYAN)
			self:ForceSync()
		end
	end)
end

function SyncEngine:_updateUI()
	local status = self._state
	self._ui:UpdateStatus(
		status,
		self.ProjectName,
		self.SyncedFiles,
		self.SyncedServices,
		self._pendingCount,
		self._watchOnly
	)
end

--------------------------------------------------------------------------------
-- Echo-Loop Prevention (Phase 1 - Bug #3 hardened)
--------------------------------------------------------------------------------
function SyncEngine:_markRecentServerChange(instancePath)
	self._recentServerChanges[instancePath] = tick()
end

function SyncEngine:_markBatchRecentServerChanges(treeData, prefix)
	-- Mark all paths in a tree as recent to prevent echo
	prefix = prefix or ""
	for _, node in ipairs(treeData) do
		local nodePath = prefix == "" and node.Name or (prefix .. "/" .. node.Name)
		self._recentServerChanges[nodePath] = tick()
		if node.Children then
			self:_markBatchRecentServerChanges(node.Children, nodePath)
		end
	end
end

function SyncEngine:_isRecentServerChange(instancePath)
	local t = self._recentServerChanges[instancePath]
	if t and (tick() - t) < Constants.ECHO_TTL then
		return true
	end
	self._recentServerChanges[instancePath] = nil
	return false
end

function SyncEngine:_setupCleanupLoop()
	task.spawn(function()
		while true do
			task.wait(10)
			local now = tick()
			for k, v in pairs(self._recentServerChanges) do
				if (now - v) > Constants.ECHO_TTL then
					self._recentServerChanges[k] = nil
				end
			end
		end
	end)
end

function SyncEngine:_beginApply()
	self._applyDepth += 1
end

function SyncEngine:_endApply()
	task.defer(function()
		self._applyDepth -= 1
	end)
end

--------------------------------------------------------------------------------
-- Applying Changes: Disk → Studio
--------------------------------------------------------------------------------
function SyncEngine:_safeDestroy(instance)
	if not instance then return false end
	if Constants.isLockedClass(instance.ClassName) then return false end

	local ok = pcall(function() instance:Destroy() end)
	return ok
end

function SyncEngine:_applyProperties(instance, properties)
	for k, v in pairs(properties) do
		if k == "Source" and instance:IsA("LuaSourceContainer") then
			if instance.Source ~= v then
				instance.Source = v
			end
		elseif k == "Tags" and type(v) == "table" then
			for _, existingTag in ipairs(instance:GetTags()) do
				instance:RemoveTag(existingTag)
			end
			for _, tag in ipairs(v) do
				instance:AddTag(tag)
			end
		elseif k == "Attributes" and type(v) == "table" then
			for attrName, attrVal in pairs(v) do
				instance:SetAttribute(attrName, attrVal)
			end
		elseif k == "Value" and instance:IsA("ValueBase") then
			pcall(function() instance.Value = deserializeValue(instance, v) end)
		elseif k ~= "Source" and k ~= "Parent" and k ~= "Name" and k ~= "ClassName" then
			pcall(function() instance[k] = v end)
		end
	end
end

-- Finds the child that a disk node refers to. Returns the instance and whether
-- it is a "container": a Model, Part or other non-syncable instance that a disk
-- folder maps onto. Containers are never replaced or destroyed; SyncRbx only
-- syncs the scripts inside them.
function SyncEngine:_findChild(parent, name, className)
	local sameName = {}
	for _, child in ipairs(parent:GetChildren()) do
		if child.Name == name then
			if child.ClassName == className then
				return child, false
			end
			table.insert(sameName, child)
		end
	end

	if className == "Folder" then
		for _, child in ipairs(sameName) do
			if not Constants.isSyncableClass(child.ClassName) then
				return child, true
			end
		end
	end

	-- A synced instance whose type changed on disk (e.g. .server.lua renamed
	-- to .client.lua); the caller replaces it.
	for _, child in ipairs(sameName) do
		if Constants.isSyncableClass(child.ClassName) and not Constants.isLockedClass(child.ClassName) then
			return child, false
		end
	end

	return nil, false
end

-- Swaps a synced instance for one of another class, moving its children over
-- so nothing inside it is lost.
function SyncEngine:_replaceInstance(old, className)
	local ok, new = pcall(function() return Instance.new(className) end)
	if not ok then
		self._logger:Log("Could not create: " .. className, Constants.Colors.RED)
		return nil
	end
	new.Name = old.Name
	for _, child in ipairs(old:GetChildren()) do
		pcall(function() child.Parent = new end)
	end
	new.Parent = old.Parent
	self:_safeDestroy(old)
	return new
end

-- Counts synced instances under `instance` that are not in `childrenNames`.
-- They only exist in Studio and are kept; the count is reported to the user.
function SyncEngine:_countStudioOnly(instance, childrenNames, stats)
	if not stats then return end
	for _, child in ipairs(instance:GetChildren()) do
		if not childrenNames[child.Name] and Constants.isSyncableClass(child.ClassName) then
			stats.studioOnly += 1
		end
	end
end

function SyncEngine:_applyNode(parentNode, nodeData, stats)
	local instance, isContainer = self:_findChild(parentNode, nodeData.Name, nodeData.ClassName)

	if instance and not isContainer and instance.ClassName ~= nodeData.ClassName then
		instance = self:_replaceInstance(instance, nodeData.ClassName)
		if not instance then return nil end
	end

	if not instance then
		-- Don't try to create locked classes
		if Constants.isLockedClass(nodeData.ClassName) then
			return nil
		end
		local ok, inst = pcall(function() return Instance.new(nodeData.ClassName) end)
		if not ok then
			self._logger:Log("Could not create: " .. tostring(nodeData.ClassName), Constants.Colors.RED)
			return nil
		end
		instance = inst
		instance.Name = nodeData.Name
		instance.Parent = parentNode
	end

	-- A container keeps its own properties; only the scripts inside are synced.
	if nodeData.Properties and not isContainer then
		self:_applyProperties(instance, nodeData.Properties)
	end

	if nodeData.Children then
		local childrenNames = {}
		for _, childData in ipairs(nodeData.Children) do
			childrenNames[childData.Name] = true
			self:_applyNode(instance, childData, stats)
		end
		-- Instances missing on disk are never destroyed here: the disk copy may
		-- simply be older than Studio. Deletions only come from explicit
		-- "Removed" events for files the user deleted.
		self:_countStudioOnly(instance, childrenNames, stats)
	end

	return instance
end

function SyncEngine:_countNodes(nodeData)
	local count = 1
	if nodeData.Children then
		for _, child in ipairs(nodeData.Children) do
			count = count + self:_countNodes(child)
		end
	end
	return count
end

function SyncEngine:_applyTree(treeData)
	self:_setState(Constants.State.SYNCING)
	ChangeHistoryService:SetWaypoint("SyncRbx: Before Sync")

	-- Phase 1 - Bug #3: Mark ALL paths in the tree as recent BEFORE applying
	self:_markBatchRecentServerChanges(treeData)

	self.SyncedFiles = 0
	self.SyncedServices = 0
	local stats = { studioOnly = 0 }

	self:_beginApply()
	local ok, err = pcall(function()
		for _, rootData in ipairs(treeData) do
			local success, service = pcall(function() return game:GetService(rootData.Name) end)
			if success and service and self:_isServiceAllowed(rootData.Name) then
				self.SyncedServices += 1
				if rootData.Children then
					local childrenNames = {}
					for _, childData in ipairs(rootData.Children) do
						childrenNames[childData.Name] = true
						self:_applyNode(service, childData, stats)
						self.SyncedFiles += self:_countNodes(childData)
					end
					self:_countStudioOnly(service, childrenNames, stats)
				end
			end
		end
	end)
	self:_endApply()

	ChangeHistoryService:SetWaypoint("SyncRbx: After Sync")
	self:_setState(self._watchOnly and Constants.State.WATCH_ONLY or Constants.State.CONNECTED)

	if not ok then
		self._logger:Log("Sync error: " .. tostring(err), Constants.Colors.RED)
		return
	end

	self._logger:Log(
		string.format("✅ Synced: %d files, %d services", self.SyncedFiles, self.SyncedServices),
		Constants.Colors.GREEN
	)
	if stats.studioOnly > 0 then
		self._logger:Log(
			string.format("%d item(s) exist only in Studio and were kept. Use 'Export' to save them to disk.", stats.studioOnly),
			Constants.Colors.YELLOW
		)
	end
	self._logger:Toast(
		string.format("Sync complete — %d files", self.SyncedFiles),
		Constants.Colors.GREEN,
		self._ui.MainFrame
	)
	self:_updateUI()
end

--------------------------------------------------------------------------------
-- Incremental Changes: Disk → Studio
--------------------------------------------------------------------------------

-- Resolves "Service/A/B". When className is given, the last segment prefers a
-- child of that class (see _findChild) instead of the first child named B.
function SyncEngine:_resolveInstanceByPath(instancePath, className)
	local parts = string.split(instancePath, "/")
	if #parts == 0 then return nil, false end

	local success, current = pcall(function() return game:GetService(parts[1]) end)
	if not success or not current then return nil, false end

	for i = 2, #parts do
		if i == #parts and className then
			return self:_findChild(current, parts[i], className)
		end
		current = current:FindFirstChild(parts[i])
		if not current then return nil, false end
	end
	return current, false
end

function SyncEngine:_applyRemoval(change)
	local instancePath = change.instancePath or ""
	local instance, isContainer = self:_resolveInstanceByPath(instancePath, change.className)
	if not instance then return end

	local reason
	if isContainer or not Constants.isSyncableClass(instance.ClassName) then
		reason = instance.ClassName .. " is not managed by SyncRbx"
	elseif change.className and instance.ClassName ~= change.className then
		reason = "it is a " .. instance.ClassName .. ", not a " .. change.className
	elseif not hasOnlySyncableDescendants(instance) then
		reason = "it contains parts or models"
	end

	if reason then
		self._logger:Log("Kept " .. instancePath .. " (" .. reason .. ")", Constants.Colors.YELLOW)
		return
	end

	self._logger:Log("Deleted: " .. instance.Name, Constants.Colors.ORANGE)
	self._logger:Toast("Deleted: " .. instance.Name, Constants.Colors.ORANGE, self._ui.MainFrame)
	self:_safeDestroy(instance)
end

function SyncEngine:_applyIncrementalChange(change)
	if self._state == Constants.State.DISCONNECTED then return end
	if not self:_isPathAllowed(change.instancePath) then return "OK" end
	local oldState = self._state
	self._state = Constants.State.SYNCING
	ChangeHistoryService:SetWaypoint("SyncRbx: Incremental Update")

	local instancePath = change.instancePath or ""
	self:_markRecentServerChange(instancePath)
	local parts = string.split(instancePath, "/")
	local parentPath = table.concat(parts, "/", 1, math.max(#parts - 1, 1))
	if change.data then
		self:_markBatchRecentServerChanges({ change.data }, parentPath)
	end

	local result = "OK"
	self:_beginApply()
	local ok, err = pcall(function()
		if change.type == "Removed" then
			self:_applyRemoval(change)
		elseif (change.type == "Added" or change.type == "Changed") and change.data and #parts >= 2 then
			local parent = self:_resolveInstanceByPath(parentPath)
			if parent then
				self:_applyNode(parent, change.data)
				self._logger:Log("D→S " .. change.type .. ": " .. (change.data.Name or parts[#parts]), Constants.Colors.BLUE)
			else
				-- Parent doesn't exist; defer full re-sync
				self._logger:Log("Parent not found, full re-sync needed: " .. parentPath, Constants.Colors.YELLOW)
				result = "RESYNC_NEEDED"
			end
		end
	end)
	self:_endApply()

	ChangeHistoryService:SetWaypoint("SyncRbx: After Incremental Update")
	self._state = oldState
	if not ok then
		self._logger:Log("Error applying change: " .. tostring(err), Constants.Colors.RED)
	end
	return result
end

-- Drops disk deletions when too many arrive at once (branch switch, pull,
-- folder moved outside the project). Studio content is kept and the user is
-- told to delete it by hand if the deletion was intended.
function SyncEngine:_filterMassDeletes(changes)
	local now = tick()
	local recent = {}
	for _, t in ipairs(self._recentRemovals) do
		if now - t < Constants.MASS_DELETE_WINDOW then
			table.insert(recent, t)
		end
	end
	self._recentRemovals = recent
	if #recent == 0 then
		self._massDeleteWarned = false
	end

	local removals = 0
	for _, change in ipairs(changes) do
		if change.type == "Removed" then
			removals += 1
		end
	end
	if removals == 0 then return changes end

	if removals + #recent <= Constants.MASS_DELETE_THRESHOLD then
		for _ = 1, removals do
			table.insert(self._recentRemovals, now)
		end
		return changes
	end

	local kept = {}
	for _, change in ipairs(changes) do
		if change.type ~= "Removed" then
			table.insert(kept, change)
		end
	end
	for _ = 1, removals do
		table.insert(self._recentRemovals, now)
	end

	self._logger:Log(
		string.format("⚠️ Ignored %d deletions from disk (too many at once). Nothing was removed in Studio; delete manually if intended.", removals),
		Constants.Colors.ORANGE
	)
	if not self._massDeleteWarned then
		self._massDeleteWarned = true
		self._logger:Toast("Mass delete blocked", Constants.Colors.ORANGE, self._ui.MainFrame)
	end
	return kept
end

--------------------------------------------------------------------------------
-- Studio → Disk Changes
--------------------------------------------------------------------------------
local READ_ONLY_PROPS = {
	AbsolutePosition = true, AbsoluteSize = true, AbsoluteRotation = true,
	AbsoluteCFrame = true, DataCost = true, ClassName = true, Parent = true,
	IsLoaded = true, UniqueId = true, DebugId = true,
}

function SyncEngine:_warnDuplicateName(instance, instancePath)
	local parent = instance.Parent
	if not parent or self._duplicateWarned[instancePath] then return end
	local count = 0
	for _, sibling in ipairs(parent:GetChildren()) do
		if sibling.Name == instance.Name and sibling.ClassName == instance.ClassName then
			count += 1
		end
	end
	if count > 1 then
		self._duplicateWarned[instancePath] = true
		self._logger:Log(
			string.format("⚠️ %d %ss named '%s' in the same place; only one can be saved to disk. Rename them.", count, instance.ClassName, instance.Name),
			Constants.Colors.ORANGE
		)
	end
end

function SyncEngine:_sendStudioChange(action, instance, propName, oldPath)
	-- Don't send the plugin's own writes, or changes while paused / watch-only
	if self._applyDepth > 0 then return end
	if self:IsSyncing() then return end
	if not self:IsConnected() then return end
	if self._watchOnly then return end -- Phase 3 - #12

	local className = instance.ClassName
	if not Constants.isSyncableClass(className) then
		-- A Model/Part holding scripts is a folder on disk; keep the folder
		-- name in step when it is renamed or moved. Anything else is ignored.
		if action == "Renamed" and hasSyncableDescendant(instance) then
			className = "Folder"
		else
			return
		end
	end

	if propName and READ_ONLY_PROPS[propName] then return end

	local instancePath = self._tracker:GetRelativePath(instance)
	if not instancePath or instancePath == "" then return end

	-- Only the chosen services reach the disk. A move between services is
	-- also reported as Removed + Added, so a Rename that crosses the boundary
	-- can be dropped safely.
	if not self:_isPathAllowed(instancePath) then return end
	if oldPath and not self:_isPathAllowed(oldPath) then return end

	-- Echo-loop prevention
	if self:_isRecentServerChange(instancePath) then return end
	if oldPath and self:_isRecentServerChange(oldPath) then return end

	-- For scripts, only sync Source changes
	if action == "Changed" and propName then
		if instance:IsA("LuaSourceContainer") and propName ~= "Source" then return end
		if instance:IsA("ValueBase") and propName ~= "Value" then return end
	end

	if action ~= "Removed" then
		self:_warnDuplicateName(instance, instancePath)
	end

	-- Build change object with deduplication key
	local changeKey = action .. "|" .. instancePath .. "|" .. tostring(propName)
	if action == "Renamed" then
		changeKey = changeKey .. "|" .. tostring(oldPath)
	end

	local change
	local existingIndex = self._pendingChangesMap[changeKey]
	if existingIndex then
		change = self._pendingStudioChanges[existingIndex]
	else
		change = {
			type = action,
			path = instancePath,
			oldPath = oldPath,
			className = className,
			name = instance.Name,
			property = propName,
		}
		table.insert(self._pendingStudioChanges, change)
		self._pendingChangesMap[changeKey] = #self._pendingStudioChanges
	end

	-- Attach data
	if (action == "Changed" or action == "Added") and instance:IsA("LuaSourceContainer") then
		change.source = instance.Source
	elseif (action == "Changed" or action == "Added") and instance:IsA("ValueBase") then
		change.value = serializeValue(instance)
	end

	-- Update pending count badge (Phase 3 - #10)
	self._pendingCount = #self._pendingStudioChanges
	self:_updateUI()

	-- Debounced flush
	if not self._debounceThread then
		self._debounceThread = task.delay(Constants.DEBOUNCE_INTERVAL, function()
			self._debounceThread = nil
			if #self._pendingStudioChanges == 0 then return end

			local batch = self._pendingStudioChanges
			self._pendingStudioChanges = {}
			self._pendingChangesMap = {}
			self._pendingCount = 0
			self:_updateUI()

			local sent = self._net:Post("/studio-change", batch)
			if not sent then
				self._logger:Log(string.format("Could not send %d change(s) to disk", #batch), Constants.Colors.RED)
				return
			end

			for _, ch in ipairs(batch) do
				self._logger:Log("S→D [" .. ch.type .. "] " .. (ch.name or ""), Constants.Colors.YELLOW)
			end
		end)
	end
end

--------------------------------------------------------------------------------
-- Instance Tracking Setup
--------------------------------------------------------------------------------
function SyncEngine:InitTracking()
	for _, srv in ipairs(self.RootServices) do
		srv.DescendantAdded:Connect(function(inst)
			self._tracker:Track(inst)
			self:_sendStudioChange("Added", inst)
		end)

		srv.DescendantRemoving:Connect(function(inst)
			-- Bug #1 fix: Send removal BEFORE untracking (path is still valid)
			self:_sendStudioChange("Removed", inst)
			self._tracker:Untrack(inst)
		end)

		self._tracker:Track(srv)
	end
end

--------------------------------------------------------------------------------
-- Public Actions
--------------------------------------------------------------------------------
function SyncEngine:ToggleConnection()
	if self._state == Constants.State.DISCONNECTED then
		-- Safety check for different project
		local success, pingData = self._net:Ping()
		if success then
			local srvProject = pingData.project or "?"
			local savedProject = game:GetAttribute("SyncRbxProject")

			if savedProject and savedProject ~= srvProject and not self._allowBypass then
				self._logger:Log("⚠️ Different project: " .. srvProject, Constants.Colors.ORANGE)
				self._logger:Log("Use 'Export' first, or press Connect again to confirm.", Constants.Colors.YELLOW)
				self._allowBypass = true
				return
			end

			game:SetAttribute("SyncRbxProject", srvProject)

			-- New project: choose the services before anything is synced
			if pingData.configured == false then
				self._allowBypass = false
				self._logger:Log("New project: choose which services to sync", Constants.Colors.CYAN)
				self:_promptServices(nil, true, function(ok)
					if ok then
						self:_setState(Constants.State.CONNECTING)
						self:StartLoop()
					else
						self._logger:Log("Connection cancelled: no services chosen", Constants.Colors.ORANGE)
					end
				end)
				return
			end
			self:_setServices(pingData.services)
		end

		self._allowBypass = false
		self:_setState(Constants.State.CONNECTING)
		self:StartLoop()
	else
		-- Disconnect
		self._allowBypass = false
		self:_setState(Constants.State.DISCONNECTED)
		self._logger:Log("Disconnected manually", Constants.Colors.ORANGE)
	end
end

function SyncEngine:ToggleWatchOnly()
	self._watchOnly = not self._watchOnly
	if self:IsConnected() then
		self:_setState(self._watchOnly and Constants.State.WATCH_ONLY or Constants.State.CONNECTED)
	end
	self:_updateUI() -- the switch also flips while disconnected
	self._logger:Log(
		self._watchOnly and "👁 Watch-only mode enabled" or "✏️ Two-way mode enabled",
		Constants.Colors.CYAN
	)
end

function SyncEngine:ForceSync()
	if not self:IsConnected() then
		self._logger:Log("Not connected", Constants.Colors.RED)
		return
	end
	self._logger:Log("Forcing re-sync...", Constants.Colors.CYAN)
	local success, treeData = self._net:GetTree()
	if success then
		self:_applyTree(treeData)
	else
		self._logger:Log("Could not get the tree from the server", Constants.Colors.RED)
	end
end

function SyncEngine:ExportAll()
	self._logger:Log("Checking server...", Constants.Colors.CYAN)
	local success, pingData = self._net:Ping()

	if not success then
		self._logger:Log("Server not found", Constants.Colors.RED)
		return
	end

	if pingData.configured == false then
		self._logger:Log("Press Connect first to choose which services to sync", Constants.Colors.ORANGE)
		return
	end
	self:_setServices(pingData.services)

	game:SetAttribute("SyncRbxProject", pingData.project or "?")
	self._allowBypass = false
	self._logger:Log("Exporting code...", Constants.Colors.CYAN)

	local batch = {}
	local function exportDescendants(parent)
		for _, inst in ipairs(parent:GetChildren()) do
			if Constants.isSyncableClass(inst.ClassName) then
				local instancePath = self._tracker:GetRelativePath(inst)
				if instancePath and instancePath ~= "" then
					self:_warnDuplicateName(inst, instancePath)
					local change = {
						type = "Added",
						path = instancePath,
						className = inst.ClassName,
						name = inst.Name,
					}
					if inst:IsA("LuaSourceContainer") then
						change.source = inst.Source
					elseif inst:IsA("ValueBase") then
						change.value = serializeValue(inst)
					end
					table.insert(batch, change)
				end
			end
			exportDescendants(inst)
		end
	end

	for _, srv in ipairs(self.RootServices) do
		if self:_isServiceAllowed(srv.Name) then
			exportDescendants(srv)
		end
	end

	if #batch > 0 then
		local pSuccess = self._net:Post("/studio-change", batch)
		if pSuccess then
			self._logger:Log("✅ Export complete (" .. #batch .. " items)", Constants.Colors.GREEN)
			self._logger:Toast("Exported " .. #batch .. " items", Constants.Colors.GREEN, self._ui.MainFrame)
		else
			self._logger:Log("Error sending files to disk", Constants.Colors.RED)
		end
	else
		self._logger:Log("No code to export", Constants.Colors.YELLOW)
	end
end

--------------------------------------------------------------------------------
-- Main Connection Loop (Phase 3 - #11 state machine, Phase 4 - #6 adaptive)
--------------------------------------------------------------------------------
function SyncEngine:StartLoop()
	if self._mainLoopThread then return end

	self._mainLoopThread = task.spawn(function()
		while self._state ~= Constants.State.DISCONNECTED do
			local success, pingData = self._net:Ping()

			-- The services file was removed while connected: stop instead of
			-- guessing what to sync.
			if success and pingData.configured == false then
				self._logger:Log("The project has no services chosen. Press Connect to choose them.", Constants.Colors.ORANGE)
				self:_setState(Constants.State.DISCONNECTED)
				break
			end

			if success then
				self:_reportServer(success, pingData)
				-- Picks up edits to syncrbx.project.json made on disk
				self:_setServices(pingData.services)

				if self._state == Constants.State.CONNECTING then
					self.ProjectName = pingData.project or "?"
					self:_setState(Constants.State.SYNCING)

					-- Initial full sync
					local tSuccess, treeData = self._net:GetTree()
					if tSuccess then
						self:_applyTree(treeData)
					else
						self._logger:Log("Error GET /tree", Constants.Colors.RED)
						self:_setState(self._watchOnly and Constants.State.WATCH_ONLY or Constants.State.CONNECTED)
					end
				end

				-- Long-polling loop
				while self:IsConnected() do
					local t0 = tick()
					local cSuccess, changes = self._net:GetChanges()

					if not cSuccess then
						self:_setState(Constants.State.CONNECTING)
						break
					else
						if changes and type(changes) == "table" and #changes > 0 then
							changes = self:_filterMassDeletes(changes)
							local needsResync = false
							for _, change in ipairs(changes) do
								if self:_applyIncrementalChange(change) == "RESYNC_NEEDED" then
									needsResync = true
								end
							end
							if needsResync then
								self._logger:Log("Running consolidated re-sync...", Constants.Colors.YELLOW)
								local success, treeData = self._net:GetTree()
								if success then self:_applyTree(treeData) end
							end
						end

						-- Phase 4 - #6: Adaptive polling
						if tick() - t0 < 0.5 and (type(changes) ~= "table" or #changes == 0) then
							task.wait(1)
						end
					end
				end
			else
				if self._state ~= Constants.State.CONNECTING then
					self:_setState(Constants.State.CONNECTING)
				end
			end

			-- Phase 4 - #6: Adaptive delay on reconnect
			local delay = self._net:GetAdaptiveDelay()
			task.wait(delay)
		end

		self._mainLoopThread = nil
	end)
end

return SyncEngine
