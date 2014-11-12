/*
This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this file,
You can obtain one at http://mozilla.org/MPL/2.0/.
*/

const { interfaces: Ci, utils: Cu } = Components;

const ADDON_ID = "newtabtools@darktrojan.net";
const BROWSER_PREFS = "browser.newtabpage.";
const EXTENSION_PREFS = "extensions.newtabtools.";

Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource://gre/modules/NewTabUtils.jsm");
Cu.import("resource://gre/modules/AddonManager.jsm");
Cu.import("resource://gre/modules/XPCOMUtils.jsm");

XPCOMUtils.defineLazyGetter(this, "thumbDir", function() {
  return OS.Path.join(OS.Constants.Path.profileDir, "newtab-savedthumbs");
});

XPCOMUtils.defineLazyModuleGetter(this, "FileUtils", "resource://gre/modules/FileUtils.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "NewTabToolsExporter", "chrome://newtabtools/content/export.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "OS", "resource://gre/modules/osfile.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "PageThumbs", "resource://gre/modules/PageThumbs.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "PageThumbsStorage", "resource://gre/modules/PageThumbs.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "Task", "resource://gre/modules/Task.jsm");

let browserPrefs = Services.prefs.getBranch(BROWSER_PREFS);
let userPrefs = Services.prefs.getBranch(EXTENSION_PREFS);

function install(aParams, aReason) {
  if (aReason == ADDON_UPGRADE) {
    let showRecent = true;
    if (userPrefs.prefHasUserValue("recent.count")) {
      showRecent = userPrefs.getIntPref("recent.count") != 0;
      userPrefs.deleteBranch("recent.count");
      userPrefs.setBoolPref("recent.show", showRecent);
    }
    if (browserPrefs.prefHasUserValue("rows") && !userPrefs.prefHasUserValue("rows")) {
      userPrefs.setIntPref("rows", browserPrefs.getIntPref("rows"));
    }
    if (browserPrefs.prefHasUserValue("columns") && !userPrefs.prefHasUserValue("columns")) {
      userPrefs.setIntPref("columns", browserPrefs.getIntPref("columns"));
    }

    Services.tm.currentThread.dispatch(function () {
      Task.spawn(function() {
        let iterator = new OS.File.DirectoryIterator(PageThumbsStorage.path);
        if (yield OS.File.exists(thumbDir)) {
          let stat = yield OS.File.stat(thumbDir);
          if (!stat.isDir) {
            yield OS.File.remove(thumbDir);
            yield OS.File.makeDir(thumbDir);
          }
        } else {
          yield OS.File.makeDir(thumbDir);
        }

        while (true) {
          let entry = yield iterator.next();
          let file = new FileUtils.File(entry.path);
          if (!file.isWritable()) {
            yield OS.File.move(entry.path, OS.Path.join(thumbDir, entry.name));
          }
        }
      }).then(
        null,
        // Clean up and return
        function onFailure(reason) {
          iterator.close();
          if (reason != StopIteration) {
            throw reason;
          }
        }
      );
    }.bind(this), Ci.nsIThread.DISPATCH_NORMAL);
  }
}
function uninstall(aParams, aReason) {
  if (aReason == ADDON_UNINSTALL) {
    Services.prefs.deleteBranch(EXTENSION_PREFS);
  }
}
function startup(aParams, aReason) {
  let defaultPrefs = Services.prefs.getDefaultBranch(EXTENSION_PREFS);
  defaultPrefs.setIntPref("rows", 3);
  defaultPrefs.setIntPref("columns", 3);
  defaultPrefs.setIntPref("donationreminder", 0);
  defaultPrefs.setCharPref("grid.margin", "small small small small");
  defaultPrefs.setCharPref("grid.spacing", "small");
  defaultPrefs.setIntPref("launcher", 3);
  defaultPrefs.setBoolPref("launcher.dark", false);
  defaultPrefs.setBoolPref("recent.show", true);
  defaultPrefs.setBoolPref("thumbs.contain", false);
  defaultPrefs.setBoolPref("thumbs.overlaptitle", true);
  defaultPrefs.setBoolPref("thumbs.hidebuttons", false);
  defaultPrefs.setBoolPref("thumbs.hidefavicons", false);

  if (userPrefs.getIntPref("donationreminder") == 0 && userPrefs.prefHasUserValue("version")) {
    userPrefs.setIntPref("donationreminder", 1);
  }
  userPrefs.setIntPref("version", parseInt(aParams.version));

  NewTabUtils.links._oldGetLinks = NewTabUtils.links.getLinks;
  NewTabUtils.links.getLinks = function Links_getLinks() {
    let pinnedLinks = Array.slice(NewTabUtils.pinnedLinks.links);
    let links = this._getMergedProviderLinks();

    // Filter blocked and pinned links.
    links = links.filter(function (link) {
      return !NewTabUtils.blockedLinks.isBlocked(link) && !NewTabUtils.pinnedLinks.isPinned(link);
    });

    // Try to fill the gaps between pinned links.
    for (let i = 0; i < pinnedLinks.length && links.length; i++)
      if (!pinnedLinks[i])
        pinnedLinks[i] = links.shift();

    // Append the remaining links if any.
    if (links.length)
      pinnedLinks = pinnedLinks.concat(links);

    if (userPrefs.prefHasUserValue("filter")) {
      let countPref = userPrefs.getCharPref("filter");
      let counts = JSON.parse(countPref);
      return pinnedLinks.filter(function(aItem) {
        if (NewTabUtils.pinnedLinks.isPinned(aItem))
          return true;
        let match = /^https?:\/\/([^\/]+)\//.exec(aItem.url);
        if (!match)
          return true;
        if (match[1] in counts) {
          if (counts[match[1]]) {
            counts[match[1]]--;
            return true;
          }
          return false;
        }
        return true;
      });
    } else {
      return pinnedLinks;
    }
  }

  userPrefs.addObserver("", prefObserver, false);
  Services.obs.addObserver(notificationObserver, "newtabtools-change", false);

  enumerateTabs(function(aWindow) {
    aWindow.location.reload();
  });

  let windowEnum = Services.wm.getEnumerator("navigator:browser");
  while (windowEnum.hasMoreElements()) {
    windowObserver.paint(windowEnum.getNext());
  }
  Services.ww.registerNotification(windowObserver);

  Services.obs.addObserver(optionsObserver, "addon-options-displayed", false);
  expirationFilter.init();

  AddonManager.addAddonListener({
    // If we call reload in shutdown, the page override is
    // still in place, and we don't want that.
    onDisabled: function(aAddon) {
      AddonManager.removeAddonListener(this);
      if (aAddon.id == ADDON_ID) {
        enumerateTabs(function(aWindow) {
          aWindow.location.reload();
        });
      }
    }
  });

  try {
    Cu.import("resource://gre/modules/DirectoryLinksProvider.jsm");
    if (NewTabUtils.links._providers.size > 0) {
      // DirectoryLinksProvider is already loaded.
      NewTabUtils.links.removeProvider(DirectoryLinksProvider);
      NewTabUtils.links.resetCache();
    } else {
      Services.obs.addObserver(startupObserver, "browser-ui-startup-complete", false);
    }
  } catch(e) {
    // DirectoryLinksProvider.jsm might not exist.
  }
}
function shutdown(aParams, aReason) {
  if (aReason == APP_SHUTDOWN) {
    return;
  }

  NewTabUtils.links.getLinks = NewTabUtils.links._oldGetLinks;
  delete NewTabUtils.links._oldGetLinks;

  let windowEnum = Services.wm.getEnumerator("navigator:browser");
  while (windowEnum.hasMoreElements()) {
    windowObserver.unpaint(windowEnum.getNext());
  }
  Services.ww.unregisterNotification(windowObserver);

  userPrefs.removeObserver("", prefObserver);
  Services.obs.removeObserver(notificationObserver, "newtabtools-change");

  Services.obs.removeObserver(optionsObserver, "addon-options-displayed");
  Cu.unload("chrome://newtabtools/content/export.jsm");

  expirationFilter.cleanup();

  if (DirectoryLinksProvider) {
    // Removing a startup observer at shutdown is absurd, but oh well.
    Services.obs.removeObserver(startupObserver, "browser-ui-startup-complete");
    NewTabUtils.links.addProvider(DirectoryLinksProvider);
  }
}

let prefObserver = {
  observe: function(aSubject, aTopic, aData) {
    switch (aData) {
    case "grid.margin":
    case "grid.spacing":
    case "launcher":
    case "launcher.dark":
    case "thumbs.contain":
    case "thumbs.overlaptitle":
    case "thumbs.hidebuttons":
    case "thumbs.hidefavicons":
      enumerateTabs(function(aWindow) {
        aWindow.newTabTools.updateUI();
      });
      break;
    case "recent.show":
      enumerateTabs(function(aWindow) {
        aWindow.newTabTools.refreshRecent();
      });
      break;
    case "columns":
    case "rows":
    case "filter":
      enumerateTabs(function(aWindow) {
        aWindow.gGrid.refresh();
      });
      break;
    }
  }
};

let notificationObserver = {
  observe: function(aSubject, aTopic, aData) {
    switch (aData) {
    case "background":
      enumerateTabs(function(aWindow) {
        aWindow.newTabTools.refreshBackgroundImage();
      });
      break;
    case "thumbnail":
      enumerateTabs(function(aWindow) {
        let tileURL = aSubject.QueryInterface(Ci.nsISupportsString);
        aWindow.newTabTools.refreshThumbnail(aSubject.data);
      });
      break;
    case "title":
      enumerateTabs(function(aWindow) {
        let tileURL = aSubject.QueryInterface(Ci.nsISupportsString);
        aWindow.newTabTools.refreshTitle(aSubject.data);
      });
    }
  }
};

let windowObserver = {
  observe: function(aSubject, aTopic, aData) {
    aSubject.addEventListener("load", function() {
      windowObserver.paint(aSubject);
    }, false);
  },
  paint: function(aWindow) {
    if (aWindow.location == "chrome://browser/content/browser.xul") {
      aWindow.document.addEventListener("TabOpen", this.onTabOpen, false);
    }
  },
  unpaint: function(aWindow) {
    if (aWindow.location == "chrome://browser/content/browser.xul") {
      aWindow.document.removeEventListener("TabOpen", this.onTabOpen, false);
    }
  },
  onTabOpen: function(aEvent) {
    let browser = aEvent.target.linkedBrowser;
    if (browser.currentURI.spec == "about:newtab") {
      browser.contentWindow.newTabTools.onVisible();
    }
  }
};

function enumerateTabs(aCallback) {
  for (let page of NewTabUtils.allPages._pages) {
    try {
      let global = Cu.getGlobalForObject(page);
      aCallback(global);
    } catch(e) {
      Cu.reportError(e);
    }
  }
}

let optionsObserver = {
  observe: function(aDocument, aTopic, aData) {
    switch(aTopic) {
    case "addon-options-displayed":
      if (aData != ADDON_ID) {
        return;
      }

      aDocument.getElementById("newtabtools.export").addEventListener("command", () => {
        NewTabToolsExporter.doExport();
      });
      aDocument.getElementById("newtabtools.import").addEventListener("command", () => {
        NewTabToolsExporter.doImport();
      });
    }
  },
};

let expirationFilter = {
  init: function() {
    PageThumbs.addExpirationFilter(this);
  },

  cleanup: function() {
    PageThumbs.removeExpirationFilter(this);
  },

  filterForThumbnailExpiration: function(aCallback) {
    let columns = userPrefs.getIntPref("columns");
    let rows = userPrefs.getIntPref("rows");
    let count = columns * rows + 10;

    if (count <= 25) {
      aCallback([]);
      return;
    }

    NewTabUtils.links.populateCache(function () {
      let urls = [];

      // Add all URLs to the list that we want to keep thumbnails for.
      for (let link of NewTabUtils.links.getLinks().slice(25, count)) {
        if (link && link.url)
          urls.push(link.url);
      }

      aCallback(urls);
    });
  }
};

// Observes browser-ui-startup-complete.
let startupObserver = {
  observe: function(aSubject, aTopic, aData) {
    // DirectoryLinksProvider removed at startup.
    NewTabUtils.links.removeProvider(DirectoryLinksProvider);
    NewTabUtils.links.resetCache();
  }
};
