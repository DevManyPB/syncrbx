local Constants = require(script.Parent.Constants)
local TweenService = game:GetService("TweenService")

local Logger = {}
Logger.__index = Logger

function Logger.new(logScroll)
	local self = setmetatable({
		_logScroll = logScroll,
		_logCount = 0,
	}, Logger)
	return self
end

-- Icon shown before each message so the kind of event reads at a glance
local function iconFor(text, color)
	local C = Constants.Colors
	if string.sub(text, 1, #"D→S") == "D→S" then return "↓" end   -- disk → Studio
	if string.sub(text, 1, #"S→D") == "S→D" then return "↑" end   -- Studio → disk
	if string.sub(text, 1, 7) == "Deleted" then return "×" end
	if color == C.RED then return "✕" end
	if color == C.ORANGE then return "!" end
	if color == C.GREEN then return "✓" end
	return "•"
end

function Logger:Log(text, color)
	color = color or Constants.Colors.TEXT_DIM
	local timeStr = os.date("%H:%M:%S")

	local dotColor = color
	local dot = iconFor(text, color)

	local logItem = Instance.new("Frame")
	logItem.Size = UDim2.new(1, 0, 0, 18)
	logItem.BackgroundTransparency = 1
	logItem.LayoutOrder = -self._logCount
	logItem.Parent = self._logScroll

	local dotLabel = Instance.new("TextLabel")
	dotLabel.Size = UDim2.new(0, 14, 1, 0)
	dotLabel.Position = UDim2.new(0, 0, 0, 0)
	dotLabel.BackgroundTransparency = 1
	dotLabel.Text = dot
	dotLabel.Font = Constants.UI.FONT_BOLD
	dotLabel.TextSize = 11
	dotLabel.TextColor3 = dotColor
	dotLabel.TextXAlignment = Enum.TextXAlignment.Center
	dotLabel.TextYAlignment = Enum.TextYAlignment.Center
	dotLabel.Parent = logItem

	local textLabel = Instance.new("TextLabel")
	textLabel.Size = UDim2.new(1, -16, 1, 0)
	textLabel.Position = UDim2.new(0, 16, 0, 0)
	textLabel.BackgroundTransparency = 1
	textLabel.Text = string.format("%s  %s", timeStr, text)
	textLabel.Font = Constants.UI.FONT_MONO
	textLabel.TextSize = 11
	-- Errors keep their color so they stand out; everything else is dimmed
	textLabel.TextColor3 = color == Constants.Colors.RED and color or Constants.Colors.TEXT_DIM
	textLabel.TextXAlignment = Enum.TextXAlignment.Left
	textLabel.TextTruncate = Enum.TextTruncate.AtEnd
	textLabel.Parent = logItem

	-- Also print to Studio Output for debugging
	if color == Constants.Colors.RED then
		warn("[SyncRbx] " .. text)
	end

	self._logCount = self._logCount + 1

	-- Purge oldest entries
	if self._logCount > Constants.MAX_LOGS then
		local children = self._logScroll:GetChildren()
		local oldest = nil
		for _, child in ipairs(children) do
			if child:IsA("Frame") and (not oldest or child.LayoutOrder > oldest.LayoutOrder) then
				oldest = child
			end
		end
		if oldest then oldest:Destroy() end
	end
end

-- Toast: brief notification that auto-fades
function Logger:Toast(text, color, parent)
	if not parent then return end
	color = color or Constants.Colors.ACCENT

	local toast = Instance.new("Frame")
	toast.Size = UDim2.new(1, -24, 0, 32)
	toast.Position = UDim2.new(0, 12, 1, 4)
	toast.AnchorPoint = Vector2.new(0, 1)
	toast.BackgroundColor3 = color
	toast.BackgroundTransparency = 0.08
	toast.ZIndex = 100
	toast.Parent = parent

	local corner = Instance.new("UICorner")
	corner.CornerRadius = UDim.new(0, Constants.UI.CORNER_RADIUS_SM)
	corner.Parent = toast

	local toastText = Instance.new("TextLabel")
	toastText.Size = UDim2.new(1, -16, 1, 0)
	toastText.Position = UDim2.new(0, 8, 0, 0)
	toastText.BackgroundTransparency = 1
	toastText.Text = text
	toastText.Font = Constants.UI.FONT_BOLD
	toastText.TextSize = 12
	toastText.TextColor3 = Constants.Colors.ON_ACCENT
	toastText.TextXAlignment = Enum.TextXAlignment.Left
	toastText.TextTruncate = Enum.TextTruncate.AtEnd
	toastText.ZIndex = 101
	toastText.Parent = toast

	-- Slide in
	local targetPos = UDim2.new(0, 12, 1, -12)
	TweenService:Create(toast, TweenInfo.new(0.35, Enum.EasingStyle.Back, Enum.EasingDirection.Out), {
		Position = targetPos
	}):Play()

	-- Auto-fade after 2.5 seconds
	task.delay(2.5, function()
		if toast.Parent then
			local tween = TweenService:Create(toast, TweenInfo.new(0.4, Enum.EasingStyle.Quad, Enum.EasingDirection.In), {
				BackgroundTransparency = 1,
				Position = UDim2.new(0, 12, 1, 4),
			})
			local textTween = TweenService:Create(toastText, TweenInfo.new(0.4), {
				TextTransparency = 1,
			})
			tween:Play()
			textTween:Play()
			tween.Completed:Connect(function()
				toast:Destroy()
			end)
		end
	end)
end

return Logger
