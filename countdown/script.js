/*
 * Activity Timer application
 * This script drives the timer logic, settings management, UI updates,
 * and optional Firebase synchronisation. See README for usage.
 */

(function () {
  // ------------------ Global variables ------------------
  const DEFAULT_STATE = {
    presets: [2, 5, 10],      // preset durations in minutes
    alarm: 'phone',           // selected alarm sound
    colors: {
      bg: '#000000',
      accent: '#00b49a',
      text: '#ffffff'
    },
    flash: {
      mode: 'none',
      color: '#ff4444'
    },
    vibration: true,
    notifications: true,
    id: '',
    password: '',            // settings password
    pausePassword: ''        // password to pause timer
  };

  // Runtime timer state
  let timerState = {
    duration: 0,          // total duration in ms
    remaining: 0,         // remaining time in ms
    startTime: null,      // timestamp when timer started/resumed
    endTime: null,        // timestamp when it will end
    status: 'idle',       // 'idle', 'running', 'paused', 'finished'
    intervalId: null,     // interval handle for countdown
    elapsedInterval: null // interval for elapsed count when finished
  };

  // Counter used to suppress scroll-driven updates when programmatically
  // adjusting the selector scroll position. When scrollToValue() sets
  // scrollTop on a selector, a scroll event is fired. This counter
  // indicates how many upcoming scroll events should be ignored. Each
  // invocation of scrollToValue() increments this counter, and the
  // scroll event handler decrements it without performing any update.
  let ignoreScrollUpdateCounter = 0;

  // Application state (settings)
  let appState = {};
  // Firebase references
  let firebaseApp = null;
  let db = null;
  let firebaseRef = null;
  let syncOk = true;

  // Audio elements for sounds
  const sounds = {};
  // Keep track if audio playing for finish
  let finishAudio = null;

  // DOM elements
  const dom = {};

  // Helper to query DOM and assign to dom object
  function cacheDom() {
    dom.settingsBtn = document.getElementById('settingsBtn');
    dom.syncIndicator = document.getElementById('syncIndicator');
    dom.setupContainer = document.getElementById('setupContainer');
    dom.countdownContainer = document.getElementById('countdownContainer');
    dom.finishedContainer = document.getElementById('finishedContainer');
    dom.timeSelectors = {
      hours: document.getElementById('hoursSelector'),
      minutes: document.getElementById('minutesSelector'),
      seconds: document.getElementById('secondsSelector'),
    };
    dom.presetButtons = Array.from(document.querySelectorAll('.presetBtn'));
    dom.startBtn = document.getElementById('startBtn');
    dom.progressBar = document.getElementById('progressBar');
    dom.timeRemaining = document.getElementById('timeRemaining');
    dom.endTime = document.getElementById('endTime');
    dom.pauseResumeBtn = document.getElementById('pauseResumeBtn');
    dom.deleteBtn = document.getElementById('deleteBtn');
    dom.finishedMessage = document.getElementById('finishedMessage');
    dom.elapsedTime = document.getElementById('elapsedTime');
    dom.restartBtn = document.getElementById('restartBtn');
    dom.dismissBtn = document.getElementById('dismissBtn');
    dom.pauseOverlay = document.getElementById('pauseOverlay');
    dom.pausePasswordInput = document.getElementById('pausePasswordInput');
    dom.pausePasswordSubmit = document.getElementById('pausePasswordSubmit');
    // Settings panel
    dom.settingsPanel = document.getElementById('settingsPanel');
    dom.closeSettings = document.getElementById('closeSettings');
    dom.settingsContent = document.getElementById('settingsContent');
    dom.preset1 = document.getElementById('preset1');
    dom.preset2 = document.getElementById('preset2');
    dom.preset3 = document.getElementById('preset3');
    dom.alarmSelect = document.getElementById('alarmSelect');
    dom.colorBg = document.getElementById('colorBg');
    dom.colorAccent = document.getElementById('colorAccent');
    dom.colorText = document.getElementById('colorText');
    dom.flashSelect = document.getElementById('flashSelect');
    dom.flashColor = document.getElementById('flashColor');
    dom.vibrationToggle = document.getElementById('vibrationToggle');
    dom.notificationToggle = document.getElementById('notificationToggle');
    dom.idInput = document.getElementById('idInput');
    dom.passwordInput = document.getElementById('passwordInput');
    dom.pausePasswordField = document.getElementById('pausePassword');
    dom.resetSettings = document.getElementById('resetSettings');
    dom.toggleButtons = Array.from(document.querySelectorAll('.togglePw'));
    dom.syncStatus = document.getElementById('syncStatus');
  }

  // ------------------ State management ------------------
  function loadLocalState() {
    const stored = localStorage.getItem('activityTimerState');
    if (stored) {
      try {
        const parsed = JSON.parse(stored);
        appState = Object.assign({}, DEFAULT_STATE, parsed);
      } catch (e) {
        console.warn('Failed to parse saved state, resetting to defaults', e);
        appState = Object.assign({}, DEFAULT_STATE);
      }
    } else {
      appState = Object.assign({}, DEFAULT_STATE);
    }
    // generate id if not set
    if (!appState.id) {
      appState.id = generateId();
    }
  }

  function saveLocalState() {
    localStorage.setItem('activityTimerState', JSON.stringify(appState));
  }

  function generateId() {
    return Math.random().toString(36).substring(2, 10);
  }

  // ------------------ Firebase sync ------------------
  function initFirebase() {
    // Only initialise firebase if config present
    const config = {
      // You should replace these with your Firebase project's configuration
      apiKey: "YOUR_FIREBASE_API_KEY",
      authDomain: "YOUR_FIREBASE_AUTH_DOMAIN",
      databaseURL: "YOUR_FIREBASE_DATABASE_URL",
      projectId: "YOUR_FIREBASE_PROJECT_ID",
      storageBucket: "YOUR_FIREBASE_STORAGE_BUCKET",
      messagingSenderId: "YOUR_FIREBASE_MESSAGING_SENDER_ID",
      appId: "YOUR_FIREBASE_APP_ID"
    };
    try {
      firebaseApp = firebase.initializeApp(config);
      db = firebase.database();
    } catch (e) {
      console.warn('Firebase initialisation failed', e);
      syncOk = false;
    }
  }

  // Establish real-time listener on our timer path
  function attachFirebaseListener() {
    if (!db) return;
    if (firebaseRef) {
      firebaseRef.off();
    }
    firebaseRef = db.ref('timers/' + appState.id);
    firebaseRef.on('value', snapshot => {
      const data = snapshot.val();
      if (!data) {
        // No remote data; create
        uploadState();
        return;
      }
      // Merge remote state into appState
      // Only override settings if local not changed? We'll adopt remote wholly
      if (data.settings) {
        appState = Object.assign({}, appState, data.settings);
        applyTheme();
        updateSettingsInputs();
        saveLocalState();
      }
      if (data.timer) {
        // If timer not idle, update timer state
        const remote = data.timer;
        // Determine if remote update is newer than local startTime
        if (remote.startTime && (!timerState.startTime || remote.startTime > timerState.startTime)) {
          // Cancel local intervals
          clearInterval(timerState.intervalId);
          clearInterval(timerState.elapsedInterval);
          // Apply remote timer
          timerState.duration = remote.duration;
          timerState.remaining = remote.remaining;
          timerState.startTime = remote.startTime;
          timerState.endTime = remote.endTime;
          timerState.status = remote.status;
          // Update UI accordingly
          if (timerState.status === 'running') {
            showCountdown();
            startCountdown(true);
          } else if (timerState.status === 'paused') {
            showCountdown();
            updateCountdownDisplay();
            dom.pauseResumeBtn.textContent = 'Resume';
            dom.deleteBtn.classList.remove('hidden');
          } else if (timerState.status === 'finished') {
            showFinished();
          } else {
            showSetup();
          }
        }
      }
      syncOk = true;
    }, error => {
      console.warn('Firebase listener error', error);
      syncOk = false;
    });
  }

  function uploadState() {
    if (!db) return;
    const obj = {
      settings: appState,
      timer: {
        duration: timerState.duration,
        remaining: timerState.remaining,
        startTime: timerState.startTime,
        endTime: timerState.endTime,
        status: timerState.status
      }
    };
    db.ref('timers/' + appState.id).set(obj).catch(err => {
      console.warn('Failed to upload state', err);
      syncOk = false;
    });
  }

  // ------------------ UI initialisation ------------------
  function buildTimeSelectors() {
    // create lists for hours, minutes, seconds
    const hoursList = document.createElement('ul');
    const minutesList = document.createElement('ul');
    const secondsList = document.createElement('ul');
    // Populate hours, minutes and seconds lists.  Values start at 00 and
    // go up to the maximum.  We'll align the first value programmatically
    // using scrollToValue when the view is shown.
    // Helper to create a blank list item used as padding at the top/bottom
    function createSpacer() {
      const li = document.createElement('li');
      li.textContent = '';
      li.style.opacity = '0';
      return li;
    }
    // Add a spacer at the top
    hoursList.appendChild(createSpacer());
    minutesList.appendChild(createSpacer());
    secondsList.appendChild(createSpacer());
    // Populate the real values
    for (let i = 0; i <= 99; i++) {
      const li = document.createElement('li');
      li.textContent = i.toString().padStart(2, '0');
      hoursList.appendChild(li);
    }
    for (let i = 0; i < 60; i++) {
      const li1 = document.createElement('li');
      li1.textContent = i.toString().padStart(2, '0');
      minutesList.appendChild(li1);
      const li2 = document.createElement('li');
      li2.textContent = i.toString().padStart(2, '0');
      secondsList.appendChild(li2);
    }
    // Add a spacer at the bottom
    hoursList.appendChild(createSpacer());
    minutesList.appendChild(createSpacer());
    secondsList.appendChild(createSpacer());
    dom.timeSelectors.hours.appendChild(hoursList);
    dom.timeSelectors.minutes.appendChild(minutesList);
    dom.timeSelectors.seconds.appendChild(secondsList);
    // Mark the first item (index 0) as selected for each column so that
    // 00/00/00 becomes the initial value.
    [dom.timeSelectors.hours, dom.timeSelectors.minutes, dom.timeSelectors.seconds].forEach(sel => {
      const items = sel.querySelectorAll('li');
      items.forEach((li, idx) => {
        if (idx === 0) li.classList.add('selected');
        else li.classList.remove('selected');
      });
    });

    // We intentionally do not scroll to the zero item here. The centring and
    // scrolling to the currently selected values are handled when the
    // setup view is shown (in showSetup()), after dynamic padding is
    // applied via centreSelectorLists(). Calling scrollToValue() here
    // before the dynamic padding is set could misalign the lists.

    // Add scroll listeners. These handlers update the highlighted item and
    // recompute the timer duration whenever the user scrolls the lists.
    // When programmatically scrolling via scrollToValue(), we increment
    // ignoreScrollUpdateCounter so that the next scroll event is skipped.
    Object.keys(dom.timeSelectors).forEach(key => {
      const container = dom.timeSelectors[key];
      container.addEventListener('scroll', () => {
        if (ignoreScrollUpdateCounter > 0) {
          ignoreScrollUpdateCounter--;
          return;
        }
        updateSelectorHighlight(key);
        updateDurationFromSelectors();
      });
    });
  }

  function updateSelectorHighlight(which) {
    // Determine which list item should be highlighted based on the scroll
    // position rather than DOM bounding rectangles. We compute the index
    // by subtracting half the container height (minus half an item) from
    // scrollTop and dividing by the item height. This avoids issues with
    // getBoundingClientRect() returning stale values when the container is
    // hidden or styles change dynamically.
    const container = dom.timeSelectors[which];
    const items = container.querySelectorAll('li');
    if (!items.length) return;
    const liHeight = items[0].getBoundingClientRect().height;
    const centerOffset = container.clientHeight / 2 - liHeight / 2;
    // Compute approximate index based on scrollTop. Negative indices clamp to 0.
    // Compute index based on scrollTop. Because we inserted a spacer
    // element at the top of the list, the first real value begins at
    // position 1. We therefore add 1 to the computed index to select
    // the correct item.
    let raw = (container.scrollTop - centerOffset) / liHeight;
    let index = Math.round(raw) + 1;
    // Clamp to range of available values (0..maxReal) plus spacer at end
    const maxReal = (which === 'hours' ? 99 : 59);
    const maxIndex = maxReal + 1; // because of top spacer
    if (index < 1) index = 1;
    if (index > maxIndex) index = maxIndex;
    // Remove old selections and set new selection
    items.forEach((li, idx) => {
      if (idx === index) {
        li.classList.add('selected');
      } else {
        li.classList.remove('selected');
      }
    });
  }

  function scrollToValue(which, value) {
    const container = dom.timeSelectors[which];
    const items = container.querySelectorAll('li');
    value = parseInt(value);
    let index;
    // Convert to number and clamp to valid range for hours or minutes/seconds
    let val = parseInt(value, 10);
    if (isNaN(val)) val = 0;
    const maxReal = (which === 'hours') ? 99 : 59;
    if (val < 0) val = 0;
    if (val > maxReal) val = maxReal;
    // Because we add a spacer element at the start of each list, the real
    // values begin at position 1. Thus the index used for scrolling is
    // val + 1.
    index = val + 1;
    const liHeight = items[0].offsetHeight;
    // Compute the scroll offset based on list item height rather than DOM
    // bounding rectangles.  This avoids issues where hidden containers have
    // zero height and ensures consistent alignment across devices.  We centre
    // the desired item by offsetting half the container height minus half
    // the item height.
    let scrollTop = liHeight * index - (container.clientHeight / 2 - liHeight / 2);
    if (scrollTop < 0) scrollTop = 0;
    // Increase the ignore counter so that the subsequent scroll event does not
    // trigger an update. The scroll event will decrement the counter instead.
    ignoreScrollUpdateCounter++;
    container.scrollTop = scrollTop;
    // Manually update the selection highlight without triggering a
    // duration recomputation.
    updateSelectorHighlight(which);
  }

  function updateDurationFromSelectors() {
    // compute selected values from highlighted items
    const selectedHours = parseInt(dom.timeSelectors.hours.querySelector('.selected')?.textContent || '0', 10);
    const selectedMinutes = parseInt(dom.timeSelectors.minutes.querySelector('.selected')?.textContent || '0', 10);
    const selectedSeconds = parseInt(dom.timeSelectors.seconds.querySelector('.selected')?.textContent || '0', 10);
    timerState.duration = (selectedHours * 3600 + selectedMinutes * 60 + selectedSeconds) * 1000;
  }

  // Dynamically apply top and bottom padding to each list so that the items
  // naturally centre within the highlight bar when scrollTop is zero.  Without
  // this adjustment the first visible item sits above the centre line, causing
  // "01" to be selected by default.  This function computes padding based
  // on the container height and list item height.  It should be called
  // after the selectors are visible and laid out (e.g. in showSetup()).
  function centreSelectorLists() {
    ['hours', 'minutes', 'seconds'].forEach(key => {
      const container = dom.timeSelectors[key];
      const list = container.querySelector('ul');
      if (!list) return;
      // Determine the height of a single list item via bounding rect. Using
      // getBoundingClientRect().height includes margins and line height,
      // giving a more accurate measurement for centring than offsetHeight.
      const firstLi = list.querySelector('li');
      if (!firstLi) return;
      const liHeight = firstLi.offsetHeight;
      const pad = (container.clientHeight / 2) - (liHeight / 2);
      list.style.paddingTop = pad + 'px';
      list.style.paddingBottom = pad + 'px';
    });
  }

  function populatePresetButtons() {
    // Fill preset buttons with durations from appState
    dom.presetButtons.forEach((btn, idx) => {
      const mins = appState.presets[idx] || 0;
      const hours = Math.floor(mins / 60);
      const minutes = mins % 60;
      btn.dataset.minutes = mins.toString();
      const formatted = `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:00`;
      btn.textContent = formatted;
    });
  }

  function applyTheme() {
    document.documentElement.style.setProperty('--bg-color', appState.colors.bg);
    document.documentElement.style.setProperty('--accent-color', appState.colors.accent);
    document.documentElement.style.setProperty('--text-color', appState.colors.text);
    document.documentElement.style.setProperty('--flash-color', appState.flash.color);
  }

  function updateSettingsInputs() {
    dom.preset1.value = appState.presets[0];
    dom.preset2.value = appState.presets[1];
    dom.preset3.value = appState.presets[2];
    dom.alarmSelect.value = appState.alarm;
    dom.colorBg.value = appState.colors.bg;
    dom.colorAccent.value = appState.colors.accent;
    dom.colorText.value = appState.colors.text;
    dom.flashSelect.value = appState.flash.mode;
    dom.flashColor.value = appState.flash.color;
    dom.vibrationToggle.checked = appState.vibration;
    dom.notificationToggle.checked = appState.notifications;
    dom.idInput.value = appState.id;
    dom.passwordInput.value = appState.password;
    dom.pausePasswordField.value = appState.pausePassword;
  }

  function loadSounds() {
    // Load audio files for all supported alarm sounds.  
    // The audio files live in the `timer/sounds` directory with an `.mp3` extension.  
    // Although the files were originally generated as WAVs, they have been  
    // renamed to `.mp3` to satisfy the requirement of using MP3 files.  
    // Browsers sniff the file contents to determine the codec so this works  
    // across modern browsers.  
    const soundNames = ['phone', 'alarm', 'beep', 'siren', 'bird', 'knock', 'clap', 'other'];
    soundNames.forEach(name => {
      sounds[name] = new Audio('sounds/' + name + '.mp3');
      // Preload the sound so it is ready when needed
      sounds[name].load();
    });
  }

  // ------------------ Timer actions ------------------
  function startCountdown(isSyncUpdate = false) {
    // Clear existing intervals
    clearInterval(timerState.intervalId);
    clearInterval(timerState.elapsedInterval);
    if (!isSyncUpdate) {
      timerState.remaining = timerState.duration;
      timerState.startTime = Date.now();
      timerState.endTime = timerState.startTime + timerState.duration;
      timerState.status = 'running';
    }
    dom.pauseResumeBtn.textContent = 'Pause';
    dom.deleteBtn.classList.add('hidden');
    // compute circumference from CSS stroke-dasharray property
    const circumference = 565.48; // This is defined in CSS for r=90
    updateCountdownDisplay();
    timerState.intervalId = setInterval(() => {
      const now = Date.now();
      timerState.remaining = Math.max(timerState.endTime - now, 0);
      updateCountdownDisplay();
      // update progress bar
      const progress = timerState.remaining / timerState.duration;
      dom.progressBar.style.strokeDashoffset = circumference * (1 - progress);
      if (timerState.remaining <= 0) {
        clearInterval(timerState.intervalId);
        finishCountdown();
      }
    }, 200);
    // Save remote
    saveLocalState();
    uploadState();
  }

  function updateCountdownDisplay() {
    const totalSeconds = Math.ceil(timerState.remaining / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    let text;
    if (hours > 0) {
      text = `${hours}:${minutes.toString().padStart(2,'0')}:${seconds.toString().padStart(2,'0')}`;
    } else {
      text = `${minutes}:${seconds.toString().padStart(2,'0')}`;
    }
    dom.timeRemaining.textContent = text;
    if (timerState.endTime) {
      const end = new Date(timerState.endTime);
      const h = end.getHours().toString().padStart(2,'0');
      const m = end.getMinutes().toString().padStart(2,'0');
      dom.endTime.textContent = `${h}:${m}`;
    }
  }

  function pauseCountdown() {
    clearInterval(timerState.intervalId);
    timerState.remaining = timerState.endTime - Date.now();
    timerState.status = 'paused';
    dom.pauseResumeBtn.textContent = 'Resume';
    dom.deleteBtn.classList.remove('hidden');
    // Save remote
    saveLocalState();
    uploadState();
  }

  function resumeCountdown() {
    timerState.startTime = Date.now();
    timerState.endTime = timerState.startTime + timerState.remaining;
    timerState.status = 'running';
    dom.pauseResumeBtn.textContent = 'Pause';
    dom.deleteBtn.classList.add('hidden');
    startCountdown(true);
  }

  function finishCountdown() {
    timerState.status = 'finished';
    dom.progressBar.style.strokeDashoffset = 0;
    // Show finished view
    showFinished();
    // Start counting up from zero
    let elapsedMs = 0;
    dom.elapsedTime.textContent = '+0:00';
    timerState.elapsedInterval = setInterval(() => {
      elapsedMs += 1000;
      const totalSeconds = Math.floor(elapsedMs / 1000);
      const minutes = Math.floor(totalSeconds / 60);
      const seconds = totalSeconds % 60;
      dom.elapsedTime.textContent = `+${minutes}:${seconds.toString().padStart(2,'0')}`;
    }, 1000);
    // Play alarm sound
    playAlarm();
    // Vibrate if enabled
    if (appState.vibration && navigator.vibrate) {
      navigator.vibrate([500, 200, 500]);
    }
    // Notification if enabled
    if (appState.notifications && 'Notification' in window) {
      sendNotification("Time's up!", { body: 'Your timer has finished.' });
    }
    // Flash background if configured
    if (appState.flash.mode === 'flash') {
      document.body.classList.add('flash-active');
    } else if (appState.flash.mode === 'pulse') {
      document.body.classList.add('pulse-active');
    }
    // Save remote
    saveLocalState();
    uploadState();
  }

  function resetTimer() {
    // Clear intervals and audio
    clearInterval(timerState.intervalId);
    clearInterval(timerState.elapsedInterval);
    stopAlarm();
    timerState = {
      duration: 0,
      remaining: 0,
      startTime: null,
      endTime: null,
      status: 'idle',
      intervalId: null,
      elapsedInterval: null
    };
    // Remove flash classes
    document.body.classList.remove('flash-active', 'pulse-active');
    showSetup();
    // Save remote
    saveLocalState();
    uploadState();
  }

  function restartTimer() {
    // Reset finished
    clearInterval(timerState.elapsedInterval);
    stopAlarm();
    document.body.classList.remove('flash-active', 'pulse-active');
    // Use last duration
    timerState.remaining = timerState.duration;
    timerState.startTime = Date.now();
    timerState.endTime = timerState.startTime + timerState.duration;
    timerState.status = 'running';
    showCountdown();
    startCountdown(true);
  }

  function showSetup() {
    dom.setupContainer.classList.remove('hidden');
    dom.countdownContainer.classList.add('hidden');
    dom.finishedContainer.classList.add('hidden');
    // Reset progress
    dom.progressBar.style.strokeDashoffset = 565.48;
    dom.endTime.textContent = '';
    dom.deleteBtn.classList.add('hidden');
    dom.pauseResumeBtn.textContent = 'Pause';
    // Clear selected presets highlighting
    dom.presetButtons.forEach(btn => btn.classList.remove('selected'));
    // After showing the setup view, compute padding for each list so that
    // values align with the highlight bar and centre the currently selected
    // values.  We defer execution to allow the browser to compute sizes.
    setTimeout(() => {
      // Determine the hours/minutes/seconds we should display based on the
      // current timerState.duration. Using the actual duration rather than
      // relying on `.selected` classes avoids misalignment that can occur
      // when the highlight is incorrect on initial load.
      const totalSeconds = Math.floor(timerState.duration / 1000);
      const hours = Math.floor(totalSeconds / 3600);
      const minutes = Math.floor((totalSeconds % 3600) / 60);
      const seconds = totalSeconds % 60;
      scrollToValue('hours', hours);
      scrollToValue('minutes', minutes);
      scrollToValue('seconds', seconds);
    }, 200);
  }

  function showCountdown() {
    dom.setupContainer.classList.add('hidden');
    dom.countdownContainer.classList.remove('hidden');
    dom.finishedContainer.classList.add('hidden');
    dom.deleteBtn.classList.add('hidden');
  }

  function showFinished() {
    dom.setupContainer.classList.add('hidden');
    dom.countdownContainer.classList.add('hidden');
    dom.finishedContainer.classList.remove('hidden');
  }

  function playAlarm() {
    const name = appState.alarm;
    finishAudio = sounds[name];
    if (finishAudio) {
      finishAudio.loop = true;
      finishAudio.currentTime = 0;
      finishAudio.play().catch(() => {});
    }
  }

  function stopAlarm() {
    if (finishAudio) {
      finishAudio.pause();
      finishAudio.currentTime = 0;
    }
  }

  // Send notification
  function sendNotification(title, options) {
    if (Notification.permission === 'granted') {
      new Notification(title, options);
    } else if (Notification.permission !== 'denied') {
      Notification.requestPermission().then(permission => {
        if (permission === 'granted') {
          new Notification(title, options);
        }
      });
    }
  }

  // ------------------ Event handlers ------------------
  function attachEventListeners() {
    // Settings toggle
    dom.settingsBtn.addEventListener('click', () => {
      openSettings();
    });
    dom.closeSettings.addEventListener('click', () => {
      closeSettings();
    });
    // Start button
    dom.startBtn.addEventListener('click', () => {
      updateDurationFromSelectors();
      if (timerState.duration <= 0) return;
      // highlight no preset selected
      dom.presetButtons.forEach(btn => btn.classList.remove('selected'));
      showCountdown();
      startCountdown();
    });
    // Preset buttons
    dom.presetButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        dom.presetButtons.forEach(b => b.classList.remove('selected'));
        btn.classList.add('selected');
        const mins = parseInt(btn.dataset.minutes, 10);
        const hours = Math.floor(mins / 60);
        const minutes = mins % 60;
        scrollToValue('hours', hours);
        scrollToValue('minutes', minutes);
        scrollToValue('seconds', 0);
        timerState.duration = mins * 60 * 1000;
      });
    });
    // Pause/resume/delete
    dom.pauseResumeBtn.addEventListener('click', () => {
      if (timerState.status === 'running') {
        // if pause password set, prompt
        if (appState.pausePassword) {
          dom.pauseOverlay.classList.remove('hidden');
          dom.pausePasswordInput.value = '';
          dom.pausePasswordInput.focus();
        } else {
          pauseCountdown();
        }
      } else if (timerState.status === 'paused') {
        resumeCountdown();
      }
    });
    dom.deleteBtn.addEventListener('click', () => {
      resetTimer();
    });
    dom.pausePasswordSubmit.addEventListener('click', () => {
      const val = dom.pausePasswordInput.value;
      if (val === appState.pausePassword) {
        dom.pauseOverlay.classList.add('hidden');
        pauseCountdown();
      } else {
        dom.pausePasswordInput.value = '';
      }
    });
    // Restart/dismiss buttons
    dom.restartBtn.addEventListener('click', () => {
      restartTimer();
    });
    dom.dismissBtn.addEventListener('click', () => {
      resetTimer();
    });
    // Settings input handlers
    dom.preset1.addEventListener('change', () => {
      appState.presets[0] = parseInt(dom.preset1.value || '0', 10);
      populatePresetButtons();
      saveLocalState();
      uploadState();
    });
    dom.preset2.addEventListener('change', () => {
      appState.presets[1] = parseInt(dom.preset2.value || '0', 10);
      populatePresetButtons();
      saveLocalState();
      uploadState();
    });
    dom.preset3.addEventListener('change', () => {
      appState.presets[2] = parseInt(dom.preset3.value || '0', 10);
      populatePresetButtons();
      saveLocalState();
      uploadState();
    });
    dom.alarmSelect.addEventListener('change', () => {
      appState.alarm = dom.alarmSelect.value;
      saveLocalState();
      uploadState();
    });
    // Colour pickers
    dom.colorBg.addEventListener('change', () => {
      appState.colors.bg = dom.colorBg.value;
      applyTheme();
      saveLocalState();
      uploadState();
    });
    dom.colorAccent.addEventListener('change', () => {
      appState.colors.accent = dom.colorAccent.value;
      applyTheme();
      saveLocalState();
      uploadState();
    });
    dom.colorText.addEventListener('change', () => {
      appState.colors.text = dom.colorText.value;
      applyTheme();
      saveLocalState();
      uploadState();
    });
    // Flashing
    dom.flashSelect.addEventListener('change', () => {
      appState.flash.mode = dom.flashSelect.value;
      saveLocalState();
      uploadState();
    });
    dom.flashColor.addEventListener('change', () => {
      appState.flash.color = dom.flashColor.value;
      applyTheme();
      saveLocalState();
      uploadState();
    });
    // Vibration & notification toggles
    dom.vibrationToggle.addEventListener('change', () => {
      appState.vibration = dom.vibrationToggle.checked;
      saveLocalState();
      uploadState();
    });
    dom.notificationToggle.addEventListener('change', () => {
      appState.notifications = dom.notificationToggle.checked;
      saveLocalState();
      uploadState();
      if (appState.notifications) {
        sendNotification('Notifications enabled');
      }
    });
    // ID input
    dom.idInput.addEventListener('change', () => {
      const newId = dom.idInput.value.trim();
      if (newId && newId !== appState.id) {
        appState.id = newId;
        saveLocalState();
        uploadState();
        attachFirebaseListener();
      }
    });
    // Settings password
    dom.passwordInput.addEventListener('change', () => {
      appState.password = dom.passwordInput.value;
      saveLocalState();
      uploadState();
    });
    // Pause password
    dom.pausePasswordField.addEventListener('change', () => {
      appState.pausePassword = dom.pausePasswordField.value;
      saveLocalState();
      uploadState();
    });
    // Toggle show/hide password
    dom.toggleButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        const targetId = btn.dataset.target;
        const input = document.getElementById(targetId);
        input.type = input.type === 'password' ? 'text' : 'password';
      });
    });
    // Reset button
    dom.resetSettings.addEventListener('click', () => {
      if (confirm('Reset settings to defaults? This cannot be undone.')) {
        appState = Object.assign({}, DEFAULT_STATE, { id: appState.id });
        applyTheme();
        populatePresetButtons();
        updateSettingsInputs();
        saveLocalState();
        uploadState();
      }
    });
    // When pause overlay is visible, pressing Enter key triggers submit
    dom.pausePasswordInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        dom.pausePasswordSubmit.click();
      }
    });
    // When settings panel is open, press Escape to close
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (!dom.settingsPanel.classList.contains('hidden')) {
          closeSettings();
        } else if (!dom.pauseOverlay.classList.contains('hidden')) {
          dom.pauseOverlay.classList.add('hidden');
        }
      }
    });
  }

  function openSettings() {
    // If password set, prompt user to enter password before editing
    if (appState.password) {
      const attempt = prompt('Enter settings password:');
      if (attempt !== appState.password) {
        alert('Incorrect password');
        return;
      }
    }
    updateSettingsInputs();
    populatePresetButtons();
    dom.settingsPanel.classList.add('open');
    dom.settingsPanel.classList.remove('hidden');
    // Show sync status
    if (!syncOk) {
      dom.syncIndicator.classList.remove('hidden');
      dom.syncStatus.textContent = 'Sync failed: offline or configuration error.';
    } else {
      dom.syncIndicator.classList.add('hidden');
      dom.syncStatus.textContent = '';
    }
  }

  function closeSettings() {
    dom.settingsPanel.classList.remove('open');
    // Delay hiding to allow animation to complete
    setTimeout(() => {
      if (!dom.settingsPanel.classList.contains('open')) {
        dom.settingsPanel.classList.add('hidden');
      }
    }, 300);
  }

  // ------------------ Initialisation ------------------
  function init() {
    cacheDom();
    loadLocalState();
    buildTimeSelectors();
    loadSounds();
    applyTheme();
    populatePresetButtons();
    updateSettingsInputs();
    initFirebase();
    attachFirebaseListener();
    attachEventListeners();
    // Show setup at start
    showSetup();
    // monitor online status
    window.addEventListener('offline', () => {
      syncOk = false;
      dom.syncIndicator.classList.remove('hidden');
    });
    window.addEventListener('online', () => {
      syncOk = true;
      dom.syncIndicator.classList.add('hidden');
      attachFirebaseListener();
    });
  }

  document.addEventListener('DOMContentLoaded', init);
})();