document.querySelector('form').onsubmit = async event => {
  event.preventDefault(); const button = document.querySelector('button'); button.disabled = true;
  try { const result = await window.companySetup.configure(document.querySelector('input').value); if (result.error) throw new Error(result.error); }
  catch (error) { document.querySelector('#error').textContent = error.message; button.disabled = false; }
};
