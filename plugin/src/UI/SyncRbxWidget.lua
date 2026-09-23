local Constants = require(script.Parent.Parent.Utils.Constants)
local TweenService = game:GetService("TweenService")

local C = Constants.Colors
local UI = Constants.UI
local State = Constants.State

local SyncRbxWidget = {}
SyncRbxWidget.__index = SyncRbxWidget

local FAST = TweenInfo.new(0.2, Enum.EasingStyle.Quad)
local MEDIUM = TweenInfo.new(0.3, Enum.EasingStyle.Quad)

function SyncRbxWidget.new(plugin)
	local self = setmetatable({}, SyncRbxWidget)

	local toolbar = plugin:CreateToolbar("SyncRbx")
	self.ToggleButton = toolbar:CreateButton("SyncRbx Panel", "Toggle SYNCRBX Panel", Constants.TOOLBAR_ICON)

	local widgetInfo = DockWidgetPluginGuiInfo.new(
		Enum.InitialDockState.Right,
		false,
		false,
		300, 520,
		260, 380
	)

	self.Widget = plugin:CreateDockWidgetPluginGui("SyncRbxSyncWidget", widgetInfo)
	self.Widget.Title = "SYNCRBX"
	-- Overlays (service picker, toasts) are drawn on top by ZIndex among siblings
	self.Widget.ZIndexBehavior = Enum.ZIndexBehavior.Sibling

	self.ToggleButton.Click:Connect(function()
		self.Widget.Enabled = not self.Widget.Enabled
	end)

	self._currentStatus = State.DISCONNECTED
	self._watchOnly = false
	self._services = nil
	self._serverInfo = { found = false }
	self._lastStats = { files = 0, services = 0 }

	self:_buildUI()
	self:_render()

	return self
end

--------------------------------------------------------------------------------
-- HELPERS
--------------------------------------------------------------------------------

local function createCorner(parent, radius)
	local c = Instance.new("UICorner")
	c.CornerRadius = UDim.new(0, radius or UI.CORNER_RADIUS)
	c.Parent = parent
	return c
end

local function createPadding(parent, t, b, l, r)
	local p = Instance.new("UIPadding")
	p.PaddingTop = UDim.new(0, t or 0)
	p.PaddingBottom = UDim.new(0, b or 0)
	p.PaddingLeft = UDim.new(0, l or 0)
	p.PaddingRight = UDim.new(0, r or 0)
	p.Parent = parent
	return p
end

local function createStroke(parent, color, thickness)
	local s = Instance.new("UIStroke")
	s.Color = color or C.BORDER
	s.Thickness = thickness or 1
	s.ApplyStrokeMode = Enum.ApplyStrokeMode.Border
	s.Transparency = 0.3
	s.Parent = parent
	return s
end

local function createList(parent, padding, direction)
	local l = Instance.new("UIListLayout")
	l.SortOrder = Enum.SortOrder.LayoutOrder
	l.FillDirection = direction or Enum.FillDirection.Vertical
	l.Padding = UDim.new(0, padding or 0)
	l.Parent = parent
	return l
end

local function createLabel(props)
	local label = Instance.new("TextLabel")
	label.BackgroundTransparency = 1
	label.Font = props.font or UI.FONT
	label.TextSize = props.size or 12
	label.TextColor3 = props.color or C.WHITE
	label.TextXAlignment = props.alignX or Enum.TextXAlignment.Left
	label.TextYAlignment = props.alignY or Enum.TextYAlignment.Center
	label.Text = props.text or ""
	label.Size = props.dims or UDim2.new(1, 0, 0, 16)
	label.Position = props.position or UDim2.new()
	label.LayoutOrder = props.order or 0
	if props.wrap then
		label.TextWrapped = true
		label.AutomaticSize = Enum.AutomaticSize.Y
	end
	label.Parent = props.parent
	return label
end

--------------------------------------------------------------------------------
-- BUILD UI
--------------------------------------------------------------------------------

function SyncRbxWidget:_buildUI()
	-- MainFrame has no layout so toasts can be positioned freely inside it
	self.MainFrame = Instance.new("Frame")
	self.MainFrame.Size = UDim2.new(1, 0, 1, 0)
	self.MainFrame.BackgroundColor3 = C.BG_DARK
	self.MainFrame.BorderSizePixel = 0
	self.MainFrame.Parent = self.Widget

	self.Content = Instance.new("Frame")
	self.Content.Size = UDim2.new(1, 0, 1, 0)
	self.Content.BackgroundTransparency = 1
	self.Content.Parent = self.MainFrame
	createList(self.Content, 0)

	self:_buildHeader()

	self.BodyFrame = Instance.new("Frame")
	self.BodyFrame.Size = UDim2.new(1, 0, 1, -(UI.HEADER_HEIGHT + UI.FOOTER_HEIGHT))
	self.BodyFrame.BackgroundTransparency = 1
	self.BodyFrame.LayoutOrder = 2
	self.BodyFrame.ClipsDescendants = true
	self.BodyFrame.Parent = self.Content
	createPadding(self.BodyFrame, UI.PADDING, UI.PADDING, UI.PADDING, UI.PADDING)
	createList(self.BodyFrame, 8)

	self:_buildStatusCard()      -- 1
	self:_buildPrimaryButton()   -- 2
	self:_buildActionButtons()   -- 3
	self:_buildHint()            -- 4
	self:_buildWatchToggle()     -- 5
	self:_buildComingSoon()      -- 6
	self:_buildLogArea()         -- 7, 8
	self:_buildFooter()

	-- Fade in
	self.MainFrame.BackgroundTransparency = 1
	task.defer(function()
		TweenService:Create(self.MainFrame, MEDIUM, { BackgroundTransparency = 0 }):Play()
	end)
end

--------------------------------------------------------------------------------
-- HEADER
--------------------------------------------------------------------------------

function SyncRbxWidget:_buildHeader()
	self.HeaderFrame = Instance.new("Frame")
	self.HeaderFrame.Size = UDim2.new(1, 0, 0, UI.HEADER_HEIGHT)
	self.HeaderFrame.BackgroundColor3 = C.BG_PANEL
	self.HeaderFrame.BorderSizePixel = 0
	self.HeaderFrame.LayoutOrder = 1
	self.HeaderFrame.Parent = self.Content

	local border = Instance.new("Frame")
	border.Size = UDim2.new(1, 0, 0, 1)
	border.Position = UDim2.new(0, 0, 1, -1)
	border.BackgroundColor3 = C.BORDER
	border.BorderSizePixel = 0
	border.Parent = self.HeaderFrame

	self.AccentLine = Instance.new("Frame")
	self.AccentLine.Size = UDim2.new(0, 0, 0, 2)
	self.AccentLine.Position = UDim2.new(0, UI.PADDING, 1, -1)
	self.AccentLine.BackgroundColor3 = C.ACCENT
	self.AccentLine.BorderSizePixel = 0
	self.AccentLine.Parent = self.HeaderFrame
	createCorner(self.AccentLine, 1)
	task.defer(function()
		TweenService:Create(self.AccentLine, TweenInfo.new(0.6, Enum.EasingStyle.Quart, Enum.EasingDirection.Out), {
			Size = UDim2.new(0, 60, 0, 2),
		}):Play()
	end)

	local logo = Instance.new("ImageLabel")
	logo.Size = UDim2.new(0, 26, 0, 26)
	logo.Position = UDim2.new(0, UI.PADDING, 0.5, 0)
	logo.AnchorPoint = Vector2.new(0, 0.5)
	logo.BackgroundTransparency = 1
	logo.Image = Constants.TOOLBAR_ICON
	logo.ScaleType = Enum.ScaleType.Fit
	logo.Parent = self.HeaderFrame

	local textLeft = UI.PADDING + 34
	self.TitleLabel = createLabel({
		parent = self.HeaderFrame, text = "SYNCRBX", font = UI.FONT_BOLD, size = 15,
		dims = UDim2.new(1, -(textLeft + 30), 0, 18), position = UDim2.new(0, textLeft, 0, 10),
	})
	self.ProjectLabel = createLabel({
		parent = self.HeaderFrame, text = "No project", size = 11, color = C.TEXT_DIM,
		dims = UDim2.new(1, -(textLeft + 30), 0, 14), position = UDim2.new(0, textLeft, 0, 30),
	})
	self.ProjectLabel.TextTruncate = Enum.TextTruncate.AtEnd

	self.StatusIndicator = Instance.new("Frame")
	self.StatusIndicator.Size = UDim2.new(0, 12, 0, 12)
	self.StatusIndicator.AnchorPoint = Vector2.new(1, 0.5)
	self.StatusIndicator.Position = UDim2.new(1, -UI.PADDING, 0.5, 0)
	self.StatusIndicator.BackgroundColor3 = C.RED
	self.StatusIndicator.Parent = self.HeaderFrame
	createCorner(self.StatusIndicator, 6)

	self.StatusGlow = Instance.new("Frame")
	self.StatusGlow.Size = UDim2.new(1, 8, 1, 8)
	self.StatusGlow.AnchorPoint = Vector2.new(0.5, 0.5)
	self.StatusGlow.Position = UDim2.new(0.5, 0, 0.5, 0)
	self.StatusGlow.BackgroundColor3 = C.GREEN
	self.StatusGlow.BackgroundTransparency = 1
	self.StatusGlow.Parent = self.StatusIndicator
	createCorner(self.StatusGlow, 10)

	self.PulseTween = TweenService:Create(
		self.StatusGlow,
		TweenInfo.new(1.2, Enum.EasingStyle.Sine, Enum.EasingDirection.InOut, -1, true),
		{ BackgroundTransparency = 0.5, Size = UDim2.new(1, 14, 1, 14) }
	)
end

--------------------------------------------------------------------------------
-- STATUS CARD (state, what to do next, synced services)
--------------------------------------------------------------------------------

function SyncRbxWidget:_buildStatusCard()
	self.StatusCard = Instance.new("Frame")
	self.StatusCard.Size = UDim2.new(1, 0, 0, 0)
	self.StatusCard.AutomaticSize = Enum.AutomaticSize.Y
	self.StatusCard.BackgroundColor3 = C.BG_SURFACE
	self.StatusCard.BorderSizePixel = 0
	self.StatusCard.LayoutOrder = 1
	self.StatusCard.Parent = self.BodyFrame
	createCorner(self.StatusCard)
	self.StatusCardStroke = createStroke(self.StatusCard, C.BORDER)
	createPadding(self.StatusCard, 10, 10, 12, 12)
	createList(self.StatusCard, 4)

	local titleRow = Instance.new("Frame")
	titleRow.Size = UDim2.new(1, 0, 0, 18)
	titleRow.BackgroundTransparency = 1
	titleRow.LayoutOrder = 1
	titleRow.Parent = self.StatusCard

	self.CardDot = Instance.new("Frame")
	self.CardDot.Size = UDim2.new(0, 8, 0, 8)
	self.CardDot.Position = UDim2.new(0, 0, 0.5, 0)
	self.CardDot.AnchorPoint = Vector2.new(0, 0.5)
	self.CardDot.BackgroundColor3 = C.RED
	self.CardDot.Parent = titleRow
	createCorner(self.CardDot, 4)

	self.StatusText = createLabel({
		parent = titleRow, text = "Disconnected", font = UI.FONT_BOLD, size = 13,
		dims = UDim2.new(1, -16, 1, 0), position = UDim2.new(0, 16, 0, 0),
	})

	-- Details or next steps; wraps to as many lines as needed
	self.StatsLabel = createLabel({
		parent = self.StatusCard, size = 11, color = C.TEXT_DIM, wrap = true, order = 2,
		dims = UDim2.new(1, 0, 0, 0), alignY = Enum.TextYAlignment.Top,
	})
	self.StatsLabel.RichText = true

	-- Synced services, e.g. "ServerScriptService · ReplicatedStorage"
	self.ServicesLabel = createLabel({
		parent = self.StatusCard, size = 11, color = C.ACCENT, wrap = true, order = 3,
		dims = UDim2.new(1, 0, 0, 0), alignY = Enum.TextYAlignment.Top,
	})
	self.ServicesLabel.Visible = false
end

--------------------------------------------------------------------------------
-- PRIMARY BUTTON (Connect / Disconnect)
--------------------------------------------------------------------------------

function SyncRbxWidget:_buildPrimaryButton()
	self.PauseBtn = Instance.new("TextButton")
	self.PauseBtn.Size = UDim2.new(1, 0, 0, UI.BTN_HEIGHT)
	self.PauseBtn.BackgroundColor3 = C.ACCENT
	self.PauseBtn.Text = "Connect"
	self.PauseBtn.Font = UI.FONT_BOLD
	self.PauseBtn.TextSize = 14
	self.PauseBtn.TextColor3 = C.ON_ACCENT
	self.PauseBtn.LayoutOrder = 2
	self.PauseBtn.AutoButtonColor = false
	self.PauseBtn.Parent = self.BodyFrame
	createCorner(self.PauseBtn)

	self.PauseBtn.MouseEnter:Connect(function()
		if self._currentStatus == State.DISCONNECTED then
			TweenService:Create(self.PauseBtn, FAST, { BackgroundColor3 = C.ACCENT_LIGHT }):Play()
		end
	end)
	self.PauseBtn.MouseLeave:Connect(function()
		TweenService:Create(self.PauseBtn, FAST, { BackgroundColor3 = self:_primaryColor() }):Play()
	end)
end

function SyncRbxWidget:_primaryColor()
	if self._currentStatus == State.CONNECTED or self._currentStatus == State.WATCH_ONLY then
		return C.BTN_BG
	elseif self._currentStatus == State.CONNECTING or self._currentStatus == State.SYNCING then
		return C.ORANGE
	end
	return C.ACCENT
end

--------------------------------------------------------------------------------
-- ACTION BUTTONS (disk ↔ Studio, services)
--------------------------------------------------------------------------------

function SyncRbxWidget:_createGhostButton(text, layoutOrder, parent, hint)
	local btn = Instance.new("TextButton")
	btn.Size = UDim2.new(0.5, -4, 1, 0)
	btn.BackgroundColor3 = C.BTN_BG
	btn.Text = text
	btn.Font = UI.FONT_BOLD
	btn.TextSize = 12
	btn.TextColor3 = C.WHITE
	btn.LayoutOrder = layoutOrder
	btn.AutoButtonColor = false
	btn.Parent = parent
	createCorner(btn, UI.CORNER_RADIUS_SM)
	createStroke(btn, C.BORDER)

	btn.MouseEnter:Connect(function()
		if btn:GetAttribute("Disabled") then return end
		TweenService:Create(btn, FAST, { BackgroundColor3 = C.BG_SURFACE }):Play()
		if hint and self.HintLabel then self.HintLabel.Text = hint end
	end)
	btn.MouseLeave:Connect(function()
		TweenService:Create(btn, FAST, { BackgroundColor3 = C.BTN_BG }):Play()
		if hint and self.HintLabel and self.HintLabel.Text == hint then self.HintLabel.Text = "" end
	end)

	return btn
end

-- Dims a button and stops it from reacting when its action is not available
local function setEnabled(btn, enabled)
	btn:SetAttribute("Disabled", not enabled)
	btn.TextTransparency = enabled and 0 or 0.6
	pcall(function() btn.Interactable = enabled end) -- older Studio versions lack it
end

function SyncRbxWidget:_buildActionButtons()
	self.ButtonBar = Instance.new("Frame")
	self.ButtonBar.Size = UDim2.new(1, 0, 0, UI.BTN_SM_HEIGHT * 2 + 8)
	self.ButtonBar.BackgroundTransparency = 1
	self.ButtonBar.LayoutOrder = 3
	self.ButtonBar.Parent = self.BodyFrame
	createList(self.ButtonBar, 8)

	local row1 = Instance.new("Frame")
	row1.Size = UDim2.new(1, 0, 0, UI.BTN_SM_HEIGHT)
	row1.BackgroundTransparency = 1
	row1.LayoutOrder = 1
	row1.Parent = self.ButtonBar
	createList(row1, 8, Enum.FillDirection.Horizontal)

	self.ForceSyncBtn = self:_createGhostButton("↓  Disk → Studio", 1, row1,
		"Reload every synced file from disk into Studio")
	self.ExportBtn = self:_createGhostButton("↑  Studio → Disk", 2, row1,
		"Save the scripts in Studio to your project folder")

	self.ServicesBtn = self:_createGhostButton("Synced services…", 2, self.ButtonBar,
		"Choose which services SyncRbx reads and writes")
	self.ServicesBtn.Size = UDim2.new(1, 0, 0, UI.BTN_SM_HEIGHT)

	-- Pending changes badge (Studio changes waiting to be sent)
	self.PendingBadge = Instance.new("TextLabel")
	self.PendingBadge.Size = UDim2.new(0, 18, 0, 18)
	self.PendingBadge.Position = UDim2.new(1, -2, 0, -4)
	self.PendingBadge.AnchorPoint = Vector2.new(1, 0)
	self.PendingBadge.BackgroundColor3 = C.ORANGE
	self.PendingBadge.Text = ""
	self.PendingBadge.Font = UI.FONT_BOLD
	self.PendingBadge.TextSize = 10
	self.PendingBadge.TextColor3 = C.ON_ACCENT
	self.PendingBadge.Visible = false
	self.PendingBadge.ZIndex = 10
	self.PendingBadge.Parent = self.ExportBtn
	createCorner(self.PendingBadge, 9)
end

function SyncRbxWidget:_buildHint()
	-- Explains the button under the mouse; empty otherwise
	self.HintLabel = createLabel({
		parent = self.BodyFrame, size = 10, color = C.TEXT_DIM, order = 4,
		dims = UDim2.new(1, 0, 0, 12),
	})
	self.HintLabel.TextTruncate = Enum.TextTruncate.AtEnd
end

--------------------------------------------------------------------------------
-- WATCH-ONLY SWITCH
--------------------------------------------------------------------------------

function SyncRbxWidget:_buildWatchToggle()
	-- The whole row is the button the engine listens to
	self.WatchOnlyBtn = Instance.new("TextButton")
	self.WatchOnlyBtn.Size = UDim2.new(1, 0, 0, 40)
	self.WatchOnlyBtn.BackgroundColor3 = C.BG_SURFACE
	self.WatchOnlyBtn.Text = ""
	self.WatchOnlyBtn.AutoButtonColor = false
	self.WatchOnlyBtn.LayoutOrder = 5
	self.WatchOnlyBtn.Parent = self.BodyFrame
	createCorner(self.WatchOnlyBtn, UI.CORNER_RADIUS_SM)
	createStroke(self.WatchOnlyBtn, C.BORDER)

	createLabel({
		parent = self.WatchOnlyBtn, text = "Watch-only", font = UI.FONT_BOLD, size = 12,
		dims = UDim2.new(1, -64, 0, 16), position = UDim2.new(0, 12, 0, 5),
	})
	local desc = createLabel({
		parent = self.WatchOnlyBtn, text = "Only receive changes from disk", size = 10, color = C.TEXT_DIM,
		dims = UDim2.new(1, -64, 0, 14), position = UDim2.new(0, 12, 0, 21),
	})
	desc.TextTruncate = Enum.TextTruncate.AtEnd

	self.WatchTrack = Instance.new("Frame")
	self.WatchTrack.Size = UDim2.new(0, 32, 0, 18)
	self.WatchTrack.AnchorPoint = Vector2.new(1, 0.5)
	self.WatchTrack.Position = UDim2.new(1, -12, 0.5, 0)
	self.WatchTrack.BackgroundColor3 = C.BTN_BG
	self.WatchTrack.Parent = self.WatchOnlyBtn
	createCorner(self.WatchTrack, 9)
	self.WatchTrackStroke = createStroke(self.WatchTrack, C.BORDER)

	self.WatchKnob = Instance.new("Frame")
	self.WatchKnob.Size = UDim2.new(0, 12, 0, 12)
	self.WatchKnob.AnchorPoint = Vector2.new(0, 0.5)
	self.WatchKnob.Position = UDim2.new(0, 3, 0.5, 0)
	self.WatchKnob.BackgroundColor3 = C.TEXT_DIM
	self.WatchKnob.Parent = self.WatchTrack
	createCorner(self.WatchKnob, 6)
end

--------------------------------------------------------------------------------
-- COMING SOON: AI bridge (MCP)
--------------------------------------------------------------------------------

function SyncRbxWidget:_buildComingSoon()
	local row = Instance.new("Frame")
	row.Size = UDim2.new(1, 0, 0, 40)
	row.BackgroundColor3 = C.BG_SURFACE
	row.BackgroundTransparency = 0.4
	row.LayoutOrder = 6
	row.Parent = self.BodyFrame
	createCorner(row, UI.CORNER_RADIUS_SM)
	local stroke = createStroke(row, C.BORDER)
	stroke.Transparency = 0.5

	local title = createLabel({
		parent = row, text = "AI Bridge (MCP)", font = UI.FONT_BOLD, size = 12, color = C.TEXT_DIM,
		dims = UDim2.new(1, -80, 0, 16), position = UDim2.new(0, 12, 0, 5),
	})
	title.TextTruncate = Enum.TextTruncate.AtEnd

	local desc = createLabel({
		parent = row, text = "Let Claude Code or Antigravity build in Studio", size = 10, color = C.TEXT_DIM,
		dims = UDim2.new(1, -80, 0, 14), position = UDim2.new(0, 12, 0, 21),
	})
	desc.TextTransparency = 0.3
	desc.TextTruncate = Enum.TextTruncate.AtEnd

	local badge = createLabel({
		parent = row, text = "SOON", font = UI.FONT_BOLD, size = 10, color = C.ACCENT,
		alignX = Enum.TextXAlignment.Center,
		dims = UDim2.new(0, 48, 0, 18), position = UDim2.new(1, -60, 0.5, -9),
	})
	badge.BackgroundTransparency = 0
	badge.BackgroundColor3 = C.BG_INPUT
	createCorner(badge, 9)
	createStroke(badge, C.ACCENT, 1)
end

--------------------------------------------------------------------------------
-- LOG AREA
--------------------------------------------------------------------------------

function SyncRbxWidget:_buildLogArea()
	local header = Instance.new("Frame")
	header.Size = UDim2.new(1, 0, 0, 18)
	header.BackgroundTransparency = 1
	header.LayoutOrder = 7
	header.Parent = self.BodyFrame

	createLabel({
		parent = header, text = "ACTIVITY", font = UI.FONT_BOLD, size = 10, color = C.TEXT_DIM,
		dims = UDim2.new(0.5, 0, 1, 0),
	})

	self.ClearLogBtn = Instance.new("TextButton")
	self.ClearLogBtn.Size = UDim2.new(0, 50, 1, 0)
	self.ClearLogBtn.AnchorPoint = Vector2.new(1, 0)
	self.ClearLogBtn.Position = UDim2.new(1, 0, 0, 0)
	self.ClearLogBtn.BackgroundTransparency = 1
	self.ClearLogBtn.Text = "Clear"
	self.ClearLogBtn.Font = UI.FONT_BOLD
	self.ClearLogBtn.TextSize = 10
	self.ClearLogBtn.TextColor3 = C.TEXT_DIM
	self.ClearLogBtn.TextXAlignment = Enum.TextXAlignment.Right
	self.ClearLogBtn.Parent = header
	self.ClearLogBtn.MouseEnter:Connect(function() self.ClearLogBtn.TextColor3 = C.ACCENT end)
	self.ClearLogBtn.MouseLeave:Connect(function() self.ClearLogBtn.TextColor3 = C.TEXT_DIM end)
	self.ClearLogBtn.MouseButton1Click:Connect(function() self:ClearLog() end)

	self.LogContainer = Instance.new("Frame")
	-- Fills the rest of the panel. UIFlexItem needs a recent Studio; older ones
	-- get an estimated height instead.
	local flexOk = pcall(function()
		local flex = Instance.new("UIFlexItem")
		flex.FlexMode = Enum.UIFlexMode.Fill
		flex.Parent = self.LogContainer
	end)
	self.LogContainer.Size = flexOk and UDim2.new(1, 0, 0, 60) or UDim2.new(1, 0, 1, -380)
	self.LogContainer.BackgroundColor3 = C.BG_INPUT
	self.LogContainer.BorderSizePixel = 0
	self.LogContainer.ClipsDescendants = true
	self.LogContainer.LayoutOrder = 8
	self.LogContainer.Parent = self.BodyFrame
	createCorner(self.LogContainer, UI.CORNER_RADIUS_SM)
	createStroke(self.LogContainer, C.BORDER)

	self.LogScroll = Instance.new("ScrollingFrame")
	self.LogScroll.Size = UDim2.new(1, -12, 1, -12)
	self.LogScroll.Position = UDim2.new(0, 6, 0, 6)
	self.LogScroll.BackgroundTransparency = 1
	self.LogScroll.ScrollBarThickness = 3
	self.LogScroll.CanvasSize = UDim2.new(0, 0, 0, 0)
	self.LogScroll.AutomaticCanvasSize = Enum.AutomaticSize.Y
	self.LogScroll.ScrollBarImageColor3 = C.ACCENT_DIM
	self.LogScroll.BorderSizePixel = 0
	self.LogScroll.Parent = self.LogContainer
	createList(self.LogScroll, 2)
end

function SyncRbxWidget:ClearLog()
	for _, child in ipairs(self.LogScroll:GetChildren()) do
		if child:IsA("Frame") then
			child:Destroy()
		end
	end
end

--------------------------------------------------------------------------------
-- FOOTER
--------------------------------------------------------------------------------

function SyncRbxWidget:_buildFooter()
	self.FooterFrame = Instance.new("Frame")
	self.FooterFrame.Size = UDim2.new(1, 0, 0, UI.FOOTER_HEIGHT)
	self.FooterFrame.BackgroundColor3 = C.BG_PANEL
	self.FooterFrame.BorderSizePixel = 0
	self.FooterFrame.LayoutOrder = 10
	self.FooterFrame.Parent = self.Content

	local border = Instance.new("Frame")
	border.Size = UDim2.new(1, 0, 0, 1)
	border.BackgroundColor3 = C.BORDER
	border.BorderSizePixel = 0
	border.Parent = self.FooterFrame

	local version = createLabel({
		parent = self.FooterFrame, text = "v" .. Constants.VERSION, size = 10, color = C.TEXT_DIM,
		dims = UDim2.new(0.5, -UI.PADDING, 1, 0), position = UDim2.new(0, UI.PADDING, 0, 0),
	})
	version.TextTransparency = 0.3

	local site = createLabel({
		parent = self.FooterFrame, text = "syncrbx.xyz", size = 10, color = C.TEXT_DIM,
		alignX = Enum.TextXAlignment.Right,
		dims = UDim2.new(0.5, -UI.PADDING, 1, 0), position = UDim2.new(0.5, 0, 0, 0),
	})
	site.TextTransparency = 0.3
end

--------------------------------------------------------------------------------
-- STATE (called by the engine)
--------------------------------------------------------------------------------

-- Result of the background ping while disconnected:
-- { found = bool, project = string?, configured = bool? }
function SyncRbxWidget:SetServerInfo(info)
	self._serverInfo = info or { found = false }
	self:_render()
end

-- Synced service names, or nil for an older server that syncs everything
function SyncRbxWidget:SetServices(services)
	self._services = services
	self:_render()
end

function SyncRbxWidget:UpdateStatus(status, projectName, syncedFiles, syncedServices, pendingCount, watchOnly)
	self._currentStatus = status or self._currentStatus
	self._watchOnly = watchOnly == true
	self._lastStats = { files = syncedFiles or 0, services = syncedServices or 0 }
	if projectName and projectName ~= "?" then
		self._projectName = projectName
	end

	pendingCount = pendingCount or 0
	self.PendingBadge.Visible = pendingCount > 0
	self.PendingBadge.Text = tostring(pendingCount)

	self:_render()
end

function SyncRbxWidget:_setIndicator(color, pulsing)
	TweenService:Create(self.StatusIndicator, MEDIUM, { BackgroundColor3 = color }):Play()
	TweenService:Create(self.CardDot, MEDIUM, { BackgroundColor3 = color }):Play()
	TweenService:Create(self.AccentLine, MEDIUM, { BackgroundColor3 = color }):Play()
	if pulsing then
		self.StatusGlow.BackgroundColor3 = color
		self.PulseTween:Play()
	else
		self.PulseTween:Cancel()
		self.StatusGlow.BackgroundTransparency = 1
	end
end

function SyncRbxWidget:_render()
	local status = self._currentStatus
	local server = self._serverInfo or {}
	local connected = status == State.CONNECTED or status == State.WATCH_ONLY

	if connected then
		local color = status == State.WATCH_ONLY and C.PURPLE or C.GREEN
		self:_setIndicator(color, true)
		self.StatusCardStroke.Color = color
		self.StatusCardStroke.Transparency = 0
		self.StatusText.Text = status == State.WATCH_ONLY and "Connected · watch-only" or "Connected"
		self.StatsLabel.Text = string.format("%d files  ·  %d services", self._lastStats.files, self._lastStats.services)
		self.ProjectLabel.Text = self._projectName or "Project"
		self.PauseBtn.Text = "Disconnect"
		self.PauseBtn.TextColor3 = C.WHITE

	elseif status == State.SYNCING then
		self:_setIndicator(C.YELLOW, false)
		self.StatusText.Text = "Syncing..."
		self.StatsLabel.Text = "Applying changes..."

	elseif status == State.CONNECTING then
		self:_setIndicator(C.ORANGE, false)
		self.StatusCardStroke.Color = C.BORDER
		self.StatusCardStroke.Transparency = 0.3
		self.StatusText.Text = "Connecting..."
		self.StatsLabel.Text = "Looking for the SyncRbx server on this computer..."
		self.PauseBtn.Text = "Cancel"
		self.PauseBtn.TextColor3 = C.ON_ACCENT

	else -- DISCONNECTED: tell the user what to do next
		self:_setIndicator(C.RED, false)
		self.StatusCardStroke.Color = C.BORDER
		self.StatusCardStroke.Transparency = 0.3
		self.PauseBtn.Text = "Connect"
		self.PauseBtn.TextColor3 = C.ON_ACCENT
		if server.found then
			self.StatusText.Text = "Ready to connect"
			self.ProjectLabel.Text = server.project or "Project"
			if server.configured == false then
				self.StatsLabel.Text = "Server found. Press <b>Connect</b> to choose what to sync."
			else
				self.StatsLabel.Text = "Server found. Press <b>Connect</b> to start syncing."
			end
		else
			self.StatusText.Text = "Server not running"
			self.ProjectLabel.Text = "No project"
			self.StatsLabel.Text = "1. Open your project folder in a terminal\n2. Run <b>syncrbx serve</b> (or Start in VS Code)\n3. Press <b>Connect</b>"
		end
	end

	TweenService:Create(self.PauseBtn, MEDIUM, { BackgroundColor3 = self:_primaryColor() }):Play()

	-- Synced services
	local showServices = connected or (server.found and server.configured)
	if showServices and self._services then
		self.ServicesLabel.Text = "Syncing: " .. table.concat(self._services, "  ·  ")
		self.ServicesLabel.Visible = true
	elseif connected then
		self.ServicesLabel.Text = "Syncing: all services"
		self.ServicesLabel.Visible = true
	else
		self.ServicesLabel.Visible = false
	end

	-- What each action needs
	setEnabled(self.ForceSyncBtn, connected)
	setEnabled(self.ExportBtn, connected or (server.found == true and server.configured ~= false))
	setEnabled(self.ServicesBtn, connected or server.found == true)

	-- Watch-only switch
	local on = self._watchOnly
	TweenService:Create(self.WatchKnob, FAST, {
		Position = on and UDim2.new(1, -15, 0.5, 0) or UDim2.new(0, 3, 0.5, 0),
		BackgroundColor3 = on and C.ON_ACCENT or C.TEXT_DIM,
	}):Play()
	TweenService:Create(self.WatchTrack, FAST, { BackgroundColor3 = on and C.PURPLE or C.BTN_BG }):Play()
	self.WatchTrackStroke.Color = on and C.PURPLE or C.BORDER
end

--------------------------------------------------------------------------------
-- SERVICE PICKER (choose which services are synced)
--------------------------------------------------------------------------------

-- options = {
--   services = { "ServerScriptService", ... },  -- rows, in order
--   selected = { ServerScriptService = true },  -- initially checked
--   hints = { Workspace = "has scripts" },      -- optional note per row
--   isFirstTime = true,
--   onConfirm = function(list) end,
--   onCancel = function() end,
-- }
function SyncRbxWidget:ShowServicePicker(options)
	self:HideServicePicker()

	local selected = {}
	for name, isOn in pairs(options.selected or {}) do
		selected[name] = isOn
	end

	local picker = Instance.new("Frame")
	picker.Size = UDim2.new(1, 0, 1, 0)
	picker.BackgroundColor3 = C.BG_DARK
	picker.BorderSizePixel = 0
	picker.Active = true -- block clicks on the panel behind
	picker.ZIndex = 20
	picker.Parent = self.Widget
	self.PickerFrame = picker
	createPadding(picker, UI.PADDING, UI.PADDING, UI.PADDING, UI.PADDING)

	local title = createLabel({
		parent = picker, text = options.isFirstTime and "Choose what to sync" or "Synced services",
		font = UI.FONT_BOLD, size = 15, dims = UDim2.new(1, 0, 0, 20),
	})
	title.ZIndex = 21

	local desc = createLabel({
		parent = picker, size = 11, color = C.TEXT_DIM,
		text = options.isFirstTime
			and "Only these services get a folder on disk. Nothing outside them is read, written or deleted."
			or "Removing a service only stops syncing it. Nothing is deleted in Studio or on disk.",
		dims = UDim2.new(1, 0, 0, 44), position = UDim2.new(0, 0, 0, 24), alignY = Enum.TextYAlignment.Top,
	})
	desc.TextWrapped = true
	desc.ZIndex = 21

	local FOOTER = UI.BTN_HEIGHT + 24
	local list = Instance.new("ScrollingFrame")
	list.Size = UDim2.new(1, 0, 1, -(72 + FOOTER))
	list.Position = UDim2.new(0, 0, 0, 72)
	list.BackgroundColor3 = C.BG_INPUT
	list.BorderSizePixel = 0
	list.ScrollBarThickness = 3
	list.ScrollBarImageColor3 = C.ACCENT_DIM
	list.CanvasSize = UDim2.new(0, 0, 0, 0)
	list.AutomaticCanvasSize = Enum.AutomaticSize.Y
	list.ZIndex = 21
	list.Parent = picker
	createCorner(list, UI.CORNER_RADIUS_SM)
	createStroke(list, C.BORDER)
	createPadding(list, 4, 4, 6, 6)
	createList(list, 2)

	for index, name in ipairs(options.services) do
		local row = Instance.new("TextButton")
		row.Size = UDim2.new(1, 0, 0, 28)
		row.BackgroundTransparency = 1
		row.Text = ""
		row.AutoButtonColor = false
		row.LayoutOrder = index
		row.ZIndex = 22
		row.Parent = list

		local box = Instance.new("Frame")
		box.Size = UDim2.new(0, 16, 0, 16)
		box.Position = UDim2.new(0, 2, 0.5, 0)
		box.AnchorPoint = Vector2.new(0, 0.5)
		box.BorderSizePixel = 0
		box.ZIndex = 23
		box.Parent = row
		createCorner(box, 4)
		local boxStroke = createStroke(box, C.BORDER)

		local check = createLabel({
			parent = box, text = "✓", font = UI.FONT_BOLD, size = 12, color = C.ON_ACCENT,
			alignX = Enum.TextXAlignment.Center, dims = UDim2.new(1, 0, 1, 0),
		})
		check.ZIndex = 24

		local label = createLabel({
			parent = row, text = name, size = 12,
			dims = UDim2.new(1, -26, 1, 0), position = UDim2.new(0, 26, 0, 0),
		})
		label.ZIndex = 23

		local hintText = options.hints and options.hints[name]
		if hintText then
			local hint = createLabel({
				parent = row, text = hintText, size = 10, color = C.TEXT_DIM,
				alignX = Enum.TextXAlignment.Right,
				dims = UDim2.new(0, 80, 1, 0), position = UDim2.new(1, -80, 0, 0),
			})
			hint.ZIndex = 23
		end

		local function refresh()
			local isOn = selected[name] == true
			box.BackgroundColor3 = isOn and C.ACCENT or C.BG_SURFACE
			boxStroke.Color = isOn and C.ACCENT or C.BORDER
			check.Visible = isOn
		end
		refresh()

		row.MouseButton1Click:Connect(function()
			selected[name] = not selected[name]
			refresh()
		end)
	end

	local warning = createLabel({
		parent = picker, text = "Choose at least one service.", size = 11, color = C.ORANGE,
		dims = UDim2.new(1, 0, 0, 16), position = UDim2.new(0, 0, 1, -(UI.BTN_HEIGHT + 20)),
	})
	warning.Visible = false
	warning.ZIndex = 21

	local buttons = Instance.new("Frame")
	buttons.Size = UDim2.new(1, 0, 0, UI.BTN_HEIGHT)
	buttons.Position = UDim2.new(0, 0, 1, -UI.BTN_HEIGHT)
	buttons.BackgroundTransparency = 1
	buttons.ZIndex = 21
	buttons.Parent = picker
	createList(buttons, 8, Enum.FillDirection.Horizontal)

	local cancelBtn = self:_createGhostButton("Cancel", 1, buttons)
	cancelBtn.ZIndex = 22

	local saveBtn = Instance.new("TextButton")
	saveBtn.Size = UDim2.new(0.5, -4, 1, 0)
	saveBtn.BackgroundColor3 = C.ACCENT
	saveBtn.Text = options.isFirstTime and "Save & Connect" or "Save"
	saveBtn.Font = UI.FONT_BOLD
	saveBtn.TextSize = 13
	saveBtn.TextColor3 = C.ON_ACCENT
	saveBtn.AutoButtonColor = false
	saveBtn.LayoutOrder = 2
	saveBtn.ZIndex = 22
	saveBtn.Parent = buttons
	createCorner(saveBtn, UI.CORNER_RADIUS_SM)

	cancelBtn.MouseButton1Click:Connect(function()
		self:HideServicePicker()
		if options.onCancel then options.onCancel() end
	end)

	saveBtn.MouseButton1Click:Connect(function()
		local chosen = {}
		for _, name in ipairs(options.services) do
			if selected[name] then
				table.insert(chosen, name)
			end
		end
		if #chosen == 0 then
			warning.Visible = true
			return
		end
		self:HideServicePicker()
		options.onConfirm(chosen)
	end)

	self.Widget.Enabled = true
end

function SyncRbxWidget:HideServicePicker()
	if self.PickerFrame then
		self.PickerFrame:Destroy()
		self.PickerFrame = nil
	end
end

return SyncRbxWidget
