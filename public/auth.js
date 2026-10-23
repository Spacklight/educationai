document.addEventListener('DOMContentLoaded', () => {
  
  // Tab Switching
  document.addEventListener('click', (e) => {
    if (e.target.id === 'tabLogin') {
      e.target.classList.add('active');
      document.getElementById('tabRegister').classList.remove('active');
      document.getElementById('loginForm').style.display = 'block';
      document.getElementById('registerForm').style.display = 'none';
    }
    if (e.target.id === 'tabRegister') {
      e.target.classList.add('active');
      document.getElementById('tabLogin').classList.remove('active');
      document.getElementById('registerForm').style.display = 'block';
      document.getElementById('loginForm').style.display = 'none';
    }
  });

  // Login Form Submit
  document.addEventListener('submit', async (e) => {
    if (e.target.id !== 'loginForm') return;
    e.preventDefault(); // Stop page reload
    
    const user = document.getElementById('loginUser').value.trim();
    const pass = document.getElementById('loginPass').value;
    const errBox = document.getElementById('loginError');
    const btn = e.target.querySelector('button');
    
    errBox.style.display = 'none';
    btn.textContent = 'Logging in...';
    btn.disabled = true;

    try {
      const r = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: user, password: pass })
      });
      const d = await r.json();
      
      if (!r.ok) throw new Error(d.error || 'Login failed');
      
      // Save to local storage and reload page to start app
      localStorage.setItem('studyHelper.profileId', d.id);
      window.location.reload(); 
      
    } catch (err) {
      errBox.textContent = err.message;
      errBox.style.display = 'block';
      btn.textContent = 'Login';
      btn.disabled = false;
    }
  });

  // Register Form Submit
  document.addEventListener('submit', async (e) => {
    if (e.target.id !== 'registerForm') return;
    e.preventDefault(); // Stop page reload

    const user = document.getElementById('regUser').value.trim();
    const pass = document.getElementById('regPass').value;
    const errBox = document.getElementById('regError');
    const btn = e.target.querySelector('button');

    if (pass.length < 4) {
      errBox.textContent = 'Password must be at least 4 characters.';
      errBox.style.display = 'block';
      return;
    }

    errBox.style.display = 'none';
    btn.textContent = 'Checking...';
    btn.disabled = true;

    try {
      // We check if username exists by attempting a dummy login (optional)
      // Move to profile form
      document.getElementById('regUserHidden').value = user;
      document.getElementById('regPassHidden').value = pass;
      
      document.getElementById('profileForm').reset();
      
      // Hide Auth, Show Profile (using the global showView function if it exists, else fallback)
      if (typeof showView === 'function') {
        showView('profile');
      } else {
        document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
        document.getElementById('profileView').classList.add('active');
      }
    } catch (err) {
      errBox.textContent = err.message;
      errBox.style.display = 'block';
    } finally {
      btn.textContent = 'Next: Your Details →';
      btn.disabled = false;
    }
  });
});
