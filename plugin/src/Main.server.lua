local RunService = game:GetService("RunService")
if not RunService:IsEdit() then return end

-- Initialize Modules
local Constants = require(script.Parent.Utils.Constants)
local Logger = require(script.Parent.Utils.Logger)
local Net = require(script.Parent.Core.Net)
local SyncRbxWidget = require(script.Parent.UI.SyncRbxWidget)
local SyncEngine = require(script.Parent.Core.SyncEngine)

-- Bootstrap plugin
local widget = SyncRbxWidget.new(plugin)
local logger = Logger.new(widget.LogScroll)
local net = Net.new()

-- Start Engine
local engine = SyncEngine.new(net, logger, widget)
engine:InitTracking()

logger:Log("SyncRbx v" .. Constants.VERSION .. " loaded", Constants.getThemeColor(Enum.StudioStyleGuideColor.DimmedText))
logger:Log("Press 'Connect' to start syncing", Constants.Colors.CYAN)
engine:_updateUI()

-- Colors are picked from the Studio theme when the plugin loads
pcall(function()
	settings().Studio.ThemeChanged:Connect(function()
		logger:Log("Studio theme changed: restart Studio to apply it to SyncRbx", Constants.Colors.CYAN)
	end)
end)

