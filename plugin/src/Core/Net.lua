local HttpService = game:GetService("HttpService")
local Constants = require(script.Parent.Parent.Utils.Constants)

local Net = {}
Net.__index = Net

function Net.new()
	local self = setmetatable({
		_requestCount = 0,
		_failCount = 0,
	}, Net)
	return self
end

function Net:Get(urlPath)
	self._requestCount += 1
	local success, res = pcall(function()
		return HttpService:GetAsync(Constants.SERVER_URL .. urlPath, true)
	end)
	if success then
		self._failCount = 0
	else
		self._failCount += 1
	end
	return success, res
end

function Net:Post(urlPath, data)
	self._requestCount += 1
	local success, res = pcall(function()
		return HttpService:PostAsync(
			Constants.SERVER_URL .. urlPath,
			HttpService:JSONEncode(data),
			Enum.HttpContentType.ApplicationJson
		)
	end)
	if success then
		self._failCount = 0
	else
		self._failCount += 1
	end
	return success, res
end

function Net:Ping()
	local success, res = pcall(function()
		return HttpService:RequestAsync({
			Url = Constants.SERVER_URL .. "/ping",
			Method = "GET",
		})
	end)

	if success and res.StatusCode == 200 then
		self._failCount = 0
		local decodeSuccess, pingData = pcall(function()
			return HttpService:JSONDecode(res.Body)
		end)
		if decodeSuccess then
			return true, pingData
		end
	end
	self._failCount += 1
	return false, nil
end

function Net:GetTree()
	local success, res = self:Get("/tree")
	if success then
		local decodeSuccess, treeData = pcall(function()
			return HttpService:JSONDecode(res)
		end)
		if decodeSuccess then
			return true, treeData
		end
	end
	return false, res
end

function Net:GetChanges()
	local success, res = self:Get("/changes")
	if success then
		local decodeSuccess, changes = pcall(function()
			return HttpService:JSONDecode(res)
		end)
		if decodeSuccess then
			return true, changes
		end
	end
	return false, res
end

-- Phase 4: Checksums endpoint
function Net:GetChecksums()
	local success, res = self:Get("/checksums")
	if success then
		local decodeSuccess, data = pcall(function()
			return HttpService:JSONDecode(res)
		end)
		if decodeSuccess then
			return true, data
		end
	end
	return false, nil
end

-- Adaptive delay based on failure count (Phase 4 #6)
function Net:GetAdaptiveDelay()
	if self._failCount <= 0 then
		return Constants.RECONNECT_BASE_DELAY
	end
	local delay = Constants.RECONNECT_BASE_DELAY * math.pow(1.5, math.min(self._failCount, 8))
	return math.min(delay, Constants.RECONNECT_MAX_DELAY)
end

return Net
