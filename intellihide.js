/*
* This code is taken from https://github.com/micheleg/dash-to-dock
*
* Licensing information:
* Dash to Dock Gnome Shell extension is distributed under the terms of the
* GNU General Public License, version 2 or later.
*
*/

const GLib = imports.gi.GLib;
const Lang = imports.lang;
const Mainloop = imports.mainloop;
const Meta = imports.gi.Meta;
const Shell = imports.gi.Shell;

const Main = imports.ui.main;
const Signals = imports.signals;

const Me = imports.misc.extensionUtils.getCurrentExtension();
const Convenience = Me.imports.convenience;

// A good compromise between reactivity and efficiency; to be tuned.
const INTELLIHIDE_CHECK_INTERVAL = 100;

const shell_version = parseFloat(
    imports.misc.config.PACKAGE_VERSION.split('.').slice(0, 2).join('.'));

const OverlapStatus = {
    UNDEFINED: -1,
    FALSE: 0,
    TRUE: 1
};

// List of windows type taken into account. Order is important (keep the original
// enum order).
const handledWindowTypes = [
  Meta.WindowType.NORMAL,
  Meta.WindowType.DIALOG,
  Meta.WindowType.MODAL_DIALOG,
  Meta.WindowType.TOOLBAR,
  Meta.WindowType.MENU,
  Meta.WindowType.UTILITY,
  Meta.WindowType.SPLASHSCREEN
];

/*
 * A rough and ugly implementation of the intellihide behaviour.
 * Intallihide object: emit 'status-changed' signal when the overlap of windows
 * with the provided targetBoxClutter.ActorBox changes;
 *
*/

const intellihide = new Lang.Class({
    Name: 'Intellihide',

    _init: function(settings) {

        // Load settings
        this._settings = settings;

        this._signalsHandler = new Convenience.GlobalSignalsHandler();
        this._tracker = Shell.WindowTracker.get_default();
        this._focusApp = null;

        this._isEnabled = false;
        this.status = OverlapStatus.UNDEFINED;
        this._targetBox = null;

        // Set intellihide to use only the active window (or not)
        this._activeWindow = false;

        // Main id of the timeout controlling timeout for updateDockVisibility function
        // when windows are dragged around (move and resize)
        this._windowChangedTimeout = 0;
        this._filterkeybindingId = 0;

        // Connect global signals
        this._signalsHandler.add (
            // Listen for notification banners to appear or disappear
            [
                Main.messageTray.actor,
                'show',
                Lang.bind(this, this._checkOverlap)
            ],
            [
                Main.messageTray.actor,
                'hide',
                Lang.bind(this, this._checkOverlap)
            ],
            // Add timeout when window grab-operation begins and remove it when it ends.
            [
                global.display,
                'grab-op-begin',
                Lang.bind(this, this._grabOpBegin)
            ],
            [
                global.display,
                'grab-op-end',
                Lang.bind(this, this._grabOpEnd)
            ],
            // This intercept keybindings and let them execute (return false)
            // The is a workaround to force an overlap check for those window
            // position and size change which are not included in the other shell signals
            // because triggered directly by this keybindings. Known examples are:
            // 'move-to-corner-**', 'move-to-monitor-**'. The check is delayed to
            // let the action be executed.
            [
                global.window_manager,
                'filter-keybinding',
                Lang.bind(this, function(){
                    // There's no need when not in normal mode (for instance in overview mode)
                    if (Main.actionMode != Shell.ActionMode.NORMAL)
                        return false;

                    this._filterkeybindingId = Mainloop.timeout_add(INTELLIHIDE_CHECK_INTERVAL,
                        Lang.bind(this, function(){
                            this._filterkeybindingId = 0;
                            this._checkOverlap();
                            return GLib.SOURCE_REMOVE;
                    }));

                    return false;
                  })
            ],
            // triggered for instance when the window list order changes,
            // included when the workspace is switched
            [
                global.screen,
                'restacked',
                Lang.bind(this, this._checkOverlap)
            ],
            // update wne monitor changes, for instance in multimonitor when monitor are attached
            [
                global.screen,
                'monitors-changed',
                Lang.bind(this, this._checkOverlap )
            ]
        );
        // direct maximize/unmazimize are not included in grab-operations
        if (shell_version >= 3.18) {
          this._signalsHandler.add (
              [
                global.window_manager,
                'size-change',
                Lang.bind(this, this._checkOverlap)
              ]
          );
        } else {
          // Since shell version 3.18, maximize and unmaximize do not exist
          // any  longer. For recent versions, size-change serves this purpose.
          this._signalsHandler.add (
              [
                global.window_manager,
                'maximize',
                Lang.bind(this, this._checkOverlap)
              ],
              [
                global.window_manager,
                'unmaximize',
                Lang.bind(this, this._checkOverlap)
              ]
          );
        }

    },

    destroy: function() {

        // Disconnect global signals
        this._signalsHandler.destroy();

        if(this._windowChangedTimeout>0)
            Mainloop.source_remove(this._windowChangedTimeout); // Just to be sure
        this._windowChangedTimeout=0;

        if(this._filterkeybindingId>0)
            Mainloop.source_remove(this._filterkeybindingId);
        this._filterkeybindingId = 0;
    },

    enable: function() {

      this._isEnabled = true;
      this._status = OverlapStatus.UNDEFINED;
      this._checkOverlap();
    },

    disable: function() {
        this._isEnabled = false;
        if(this._windowChangedTimeout>0)
            Mainloop.source_remove(this._windowChangedTimeout);
        this._windowChangedTimeout = 0;
    },

    updateTargetBox: function(box) {
        this._targetBox = box;
        this._checkOverlap();
    },

    forceUpdate: function() {
        this._status = OverlapStatus.UNDEFINED;
        this._checkOverlap();
    },

    getOverlapStatus: function(){
        if(this._status == OverlapStatus.TRUE)
            return true;
        else
            return false;
    },

    _grabOpBegin: function() {
        if(this._isEnabled){
            if(this._windowChangedTimeout>0)
                Mainloop.source_remove(this._windowChangedTimeout); // Just to be sure

            this._windowChangedTimeout = Mainloop.timeout_add(INTELLIHIDE_CHECK_INTERVAL,
                Lang.bind(this, function(){
                    this._checkOverlap();
                    return true; // to make the loop continue
                })
            );
        }
    },

    _grabOpEnd: function() {

            if(this._windowChangedTimeout>0)
                Mainloop.source_remove(this._windowChangedTimeout);

            this._windowChangedTimeout=0;
            this._checkOverlap();
    },

    _checkOverlap: function() {

        if( !this._isEnabled || this._targetBox == null)
            return;

        let overlaps = OverlapStatus.FALSE;
        let windows = global.get_window_actors();

        if (windows.length>0){

            // This is the window on top of all others in the current workspace
            let topWindow = windows[windows.length-1].get_meta_window();
            // If there isn't a focused app, use that of the window on top
            this._focusApp = this._tracker.focus_app || this._tracker.get_window_app(topWindow);

            windows = windows.filter(this._intellihideFilterInteresting, this);

            for(let i=0; i< windows.length; i++){

                let win = windows[i].get_meta_window();
                if(win){
                    let rect = win.get_frame_rect();

                    let test = ( rect.x < this._targetBox.x2) &&
                               ( rect.x +rect.width > this._targetBox.x1 ) &&
                               ( rect.y < this._targetBox.y2 ) &&
                               ( rect.y +rect.height > this._targetBox.y1 );

                    if(test){
                        overlaps = OverlapStatus.TRUE;
                        break;
                    }
                }
            }
        }

        // Check if notification banner overlaps
        if(Main.messageTray.actor.visible) {
            let rect = Main.messageTray.actor.get_allocation_box(),
                test = ( rect.x1 < this._targetBox.x2) &&
                       ( rect.x2 > this._targetBox.x1 ) &&
                       ( rect.y1 < this._targetBox.y2 ) &&
                       ( rect.y2 > this._targetBox.y1 );

            if(test) overlaps = OverlapStatus.TRUE;
        }

        if ( this._status !== overlaps ) {
            this._status = overlaps;
            this.emit('status-changed', this._status);
        }

    },

    // Filter interesting windows to be considered for intellihide.
    // Consider all windows visible on the current workspace.
    // Optionally skip windows of other applications
    _intellihideFilterInteresting: function(wa){

        var currentWorkspace = global.screen.get_active_workspace_index();

        var meta_win = wa.get_meta_window();
        if (!meta_win) {
            return false;
        }

        if ( !this._handledWindow(meta_win) )
            return false;

        var wksp = meta_win.get_workspace();
        var wksp_index = wksp.index();
        let currentApp = this._tracker.get_window_app(meta_win);

        if(this._activeWindow) {
            if(wksp_index != currentWorkspace || this._focusApp != currentApp) {
                return false;
            } else {
                return true;
            }
        }

        // Skip windows of other apps
        // "intellihide-perapp" option is always false
        if(this._focusApp && false) {
            // The DropDownTerminal extension is not an application per se
            // so we match its window by wm class instead
            if (meta_win.get_wm_class() == 'DropDownTerminalWindow')
                return true;

            //let currentApp = this._tracker.get_window_app(meta_win);

            // But consider half maximized windows ( Useful if one is using
            // two apps side by side and windows which are alwayson top
            if( this._focusApp != currentApp
                && !(meta_win.maximized_vertically && !meta_win.maximized_horizontally)
                && !meta_win.is_above()
              ) {
                return false;
            }
        }

        if ( wksp_index == currentWorkspace && meta_win.showing_on_its_workspace() ) {
            return true;
        } else {
            return false;
        }

    },

    // Filter windows by type
    // inspired by Opacify@gnome-shell.localdomain.pl
    _handledWindow: function(metaWindow) {
        // The DropDownTerminal extension uses the POPUP_MENU window type hint
        // so we match its window by wm class instead
        if (metaWindow.get_wm_class() == 'DropDownTerminalWindow')
            return true;

        var wtype = metaWindow.get_window_type();
        for (var i = 0; i < handledWindowTypes.length; i++) {
            var hwtype = handledWindowTypes[i];
            if (hwtype == wtype) {
                return true;
            } else if (hwtype > wtype) {
                return false;
            }
        }
        return false;

    },

    _onlyActive: function(active) {
        this._activeWindow = active;
     }

});

Signals.addSignalMethods(intellihide.prototype);

