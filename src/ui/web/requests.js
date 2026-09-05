import { escape, safeUrl } from "/views.js";

/** Keep pending forms in place while transcript events stream past them. */
export function syncRequests(container, requests, answer) {
  for (const form of [...container.children]) if (!requests.some(request => request.id === form.dataset.request)) form.remove();
  for (const request of requests) {
    if ([...container.children].some(form => form.dataset.request === request.id)) continue;
    const form = document.createElement("form"); form.className = "request"; form.dataset.request = request.id;
    const questions = request.questions || [];
    const schema = request.input?.requestedSchema || request.input?.schema;
    const fields = Object.entries(schema?.properties || {});
    form.innerHTML = `<div class="eyebrow">Your agent needs you</div><h2>${escape(request.title)}</h2>${request.kind === "questions" ? questions.map((q, i) => `<fieldset><legend>${escape(q.question || q.header || q.id)}</legend>${(q.options || []).map((option, j) => `<label class="choice"><input type="${q.multiSelect ? "checkbox" : "radio"}" name="question-${i}" value="${j}"><span>${escape(option.label)}${option.description ? `<small>${escape(option.description)}</small>` : ""}</span></label>`).join("")}<label>Write an answer<input name="text-${i}" autocomplete="off" ${q.isSecret ? 'type="password"' : ""}></label></fieldset>`).join("") : `<pre>${escape(JSON.stringify(request.input, null, 2))}</pre>`}${request.kind === "elicitation" ? `${request.input?.url ? `<p class="caption"><a href="${escape(safeUrl(request.input.url))}" target="_blank" rel="noopener noreferrer">Open authorization page ↗</a></p>` : ""}${fields.map(([name, field], i) => `<label>${escape(field.title || name)}${field.enum ? `<select name="field-${i}">${field.enum.map(v => `<option>${escape(v)}</option>`).join("")}</select>` : field.type === "boolean" ? `<select name="field-${i}"><option value="true">Yes</option><option value="false">No</option></select>` : `<input name="field-${i}" ${["number", "integer"].includes(field.type) ? 'type="number"' : 'type="text"'} ${schema.required?.includes(name) ? "required" : ""}>`}</label>`).join("")}${!fields.length && !request.input?.url ? `<label>Response as JSON<textarea name="json" rows="4">{}</textarea></label>` : ""}` : ""}<p class="caption" role="status"></p><div class="actions"><button type="submit" class="button primary">${request.kind === "permission" ? "Allow once" : "Send response"}</button><button type="button" class="button" data-deny>Decline</button></div>`;
    const send = async allow => {
      const response = { allow };
      try {
        if (allow && request.kind === "questions") {
          response.answers = {};
          questions.forEach((q, i) => {
            const typed = form.elements[`text-${i}`].value.trim();
            const chosen = [...form.querySelectorAll(`input[name="question-${i}"]:checked`)].map(input => q.options[Number(input.value)].label);
            const value = typed || chosen.join(", ");
            if (!value) throw new Error("Answer each question before sending.");
            response.answers[q.id || q.question] = value;
          });
        }
        if (allow && request.kind === "elicitation") {
          if (!form.reportValidity()) return;
          response.content = fields.length ? Object.fromEntries(fields.map(([name, field], i) => { const value = form.elements[`field-${i}`].value; return [name, field.type === "boolean" ? value === "true" : ["number", "integer"].includes(field.type) ? Number(value) : value]; })) : form.elements.json ? JSON.parse(form.elements.json.value) : {};
        }
        for (const button of form.querySelectorAll("button")) button.disabled = true;
        form.setAttribute("aria-busy", "true");
        form.querySelector('[role="status"]').textContent = allow ? "Sending your response…" : "Declining request…";
        await answer(request.id, response);
      } catch (error) { form.removeAttribute("aria-busy"); form.querySelector('[role="status"]').textContent = error.message; for (const button of form.querySelectorAll("button")) button.disabled = false; }
    };
    form.addEventListener("submit", event => { event.preventDefault(); send(true); });
    form.querySelector("[data-deny]").addEventListener("click", () => send(false));
    container.append(form);
  }
}
