local Constants = {}

Constants.SERVER_URL = "http://localhost:34872"
Constants.DEBOUNCE_INTERVAL = 0.4
Constants.ECHO_TTL = 3
Constants.MAX_LOGS = 120
Constants.LONG_POLL_TIMEOUT = 30
Constants.RECONNECT_BASE_DELAY = 2
Constants.RECONNECT_MAX_DELAY = 15
Constants.VERSION = "1.1.0"

-- Toolbar button icon: plugin/SyncRbxIcon.png uploaded to Roblox as an image.
Constants.TOOLBAR_ICON = "rbxassetid://118334825467286"

-- Deletions coming from disk are paused when more than this many arrive
-- within MASS_DELETE_WINDOW seconds (e.g. a git branch switch).
Constants.MASS_DELETE_THRESHOLD = 20
Constants.MASS_DELETE_WINDOW = 5

-- Colors follow the Studio theme (read when the plugin loads). ACCENT is the
-- SyncRbx brand cyan used by the logo, the website and the extension.
local DARK_COLORS = {
	ACCENT      = Color3.fromRGB(6, 182, 212),     -- Brand cyan (#06B6D4)
	ACCENT_LIGHT = Color3.fromRGB(46, 232, 255),   -- Hover (#2EE8FF)
	ACCENT_DIM  = Color3.fromRGB(14, 79, 92),      -- Scrollbars / subtle borders
	ON_ACCENT   = Color3.fromRGB(4, 20, 26),       -- Text on colored buttons
	GREEN       = Color3.fromRGB(34, 197, 94),     -- Connected / success
	GREEN_LIGHT = Color3.fromRGB(74, 222, 128),
	GREEN_DIM   = Color3.fromRGB(22, 101, 52),
	RED         = Color3.fromRGB(239, 68, 68),     -- Error / disconnected
	YELLOW      = Color3.fromRGB(234, 179, 8),     -- Syncing
	BLUE        = Color3.fromRGB(59, 130, 246),    -- Disk → Studio
	CYAN        = Color3.fromRGB(34, 211, 238),    -- Info messages
	PURPLE      = Color3.fromRGB(168, 85, 247),    -- Watch-only
	ORANGE      = Color3.fromRGB(249, 115, 22),    -- Connecting / warning
	WHITE       = Color3.fromRGB(226, 232, 240),   -- Primary text
	TEXT_DIM    = Color3.fromRGB(148, 163, 184),   -- Secondary text
	BG_DARK     = Color3.fromRGB(10, 13, 18),      -- Main background
	BG_PANEL    = Color3.fromRGB(13, 17, 23),      -- Header / footer
	BG_SURFACE  = Color3.fromRGB(17, 22, 28),      -- Cards
	BG_INPUT    = Color3.fromRGB(8, 10, 14),       -- Log area
	BORDER      = Color3.fromRGB(30, 35, 42),
	BTN_BG      = Color3.fromRGB(22, 27, 34),
}

local LIGHT_COLORS = {
	ACCENT      = Color3.fromRGB(8, 145, 178),     -- Darker cyan for contrast on white
	ACCENT_LIGHT = Color3.fromRGB(6, 182, 212),
	ACCENT_DIM  = Color3.fromRGB(165, 222, 235),
	ON_ACCENT   = Color3.fromRGB(255, 255, 255),
	GREEN       = Color3.fromRGB(22, 163, 74),
	GREEN_LIGHT = Color3.fromRGB(34, 197, 94),
	GREEN_DIM   = Color3.fromRGB(187, 247, 208),
	RED         = Color3.fromRGB(220, 38, 38),
	YELLOW      = Color3.fromRGB(161, 98, 7),
	BLUE        = Color3.fromRGB(37, 99, 235),
	CYAN        = Color3.fromRGB(8, 145, 178),
	PURPLE      = Color3.fromRGB(147, 51, 234),
	ORANGE      = Color3.fromRGB(234, 88, 12),
	WHITE       = Color3.fromRGB(15, 23, 42),      -- Primary text (dark on light)
	TEXT_DIM    = Color3.fromRGB(100, 116, 139),
	BG_DARK     = Color3.fromRGB(241, 245, 249),
	BG_PANEL    = Color3.fromRGB(255, 255, 255),
	BG_SURFACE  = Color3.fromRGB(255, 255, 255),
	BG_INPUT    = Color3.fromRGB(248, 250, 252),
	BORDER      = Color3.fromRGB(203, 213, 225),
	BTN_BG      = Color3.fromRGB(226, 232, 240),
}

local okTheme, themeName = pcall(function() return settings().Studio.Theme.Name end)
Constants.IS_LIGHT_THEME = okTheme and themeName == "Light"
Constants.Colors = Constants.IS_LIGHT_THEME and LIGHT_COLORS or DARK_COLORS

-- UI Layout
Constants.UI = {
	PADDING = 12,
	CORNER_RADIUS = 8,
	CORNER_RADIUS_SM = 6,
	HEADER_HEIGHT = 56,
	STATUS_CARD_HEIGHT = 52,
	BTN_HEIGHT = 36,
	BTN_SM_HEIGHT = 30,
	LOG_HEADER_HEIGHT = 24,
	FOOTER_HEIGHT = 28,
	FONT = Enum.Font.GothamMedium,
	FONT_BOLD = Enum.Font.GothamBold,
	FONT_MONO = Enum.Font.RobotoMono,
}

-- Connection state machine
Constants.State = {
	DISCONNECTED = "disconnected",
	CONNECTING   = "connecting",
	SYNCING      = "syncing",
	CONNECTED    = "connected",
	WATCH_ONLY   = "watch_only",
}

-- Services the user can choose to sync, in the order shown in the picker.
-- The server accepts the same names (ROOT_SERVICES in converters.js).
Constants.SELECTABLE_SERVICES = {
	"ServerScriptService",
	"ServerStorage",
	"ReplicatedStorage",
	"ReplicatedFirst",
	"StarterPlayer",
	"StarterGui",
	"StarterPack",
	"Workspace",
	"Lighting",
	"SoundService",
}

-- Pre-selected on a new project, together with any service that already has
-- scripts in the place.
Constants.DEFAULT_SERVICES = {
	ServerScriptService = true,
	ReplicatedStorage = true,
	StarterPlayer = true,
}

-- Classes that SyncRbx knows how to sync
local SYNCABLE_CLASSES = {
	Folder = true,
	Script = true,
	LocalScript = true,
	ModuleScript = true,
	StringValue = true,
	IntValue = true,
	NumberValue = true,
	BoolValue = true,
	Color3Value = true,
	Configuration = true,
	RemoteEvent = true,
	RemoteFunction = true,
	BindableEvent = true,
	BindableFunction = true,
}

-- Classes whose Parent is locked by Roblox (can't destroy/reparent)
local LOCKED_CLASSES = {
	StarterPlayerScripts = true,
	StarterCharacterScripts = true,
	Terrain = true,
	Camera = true,
}

function Constants.isSyncableClass(className)
	return SYNCABLE_CLASSES[className] == true
end

function Constants.isLockedClass(className)
	return LOCKED_CLASSES[className] == true
end

function Constants.getThemeColor(guideColor)
	return settings().Studio.Theme:GetColor(guideColor)
end

return Constants
