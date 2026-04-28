import re
import os
import pdfplumber
from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI(title="Banorte PDF Parser API")

# Allow CORS for local testing and GitHub Pages
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Restrict this to GitHub Pages domain in production
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

MONTH_MAP = {
    "ENE": "01", "FEB": "02", "MAR": "03", "ABR": "04",
    "MAY": "05", "JUN": "06", "JUL": "07", "AGO": "08",
    "SEP": "09", "OCT": "10", "NOV": "11", "DIC": "12"
}

def parse_banorte_date(date_str):
    """Convierte '20-FEB-2026' a '2026-02-20'."""
    parts = date_str.split('-')
    if len(parts) == 3:
        d, m, y = parts
        m_num = MONTH_MAP.get(m.upper(), "01")
        return f"{y}-{m_num}-{d.zfill(2)}"
    return date_str

@app.get("/")
def read_root():
    return {"status": "ok", "message": "API is running"}

@app.get("/api/main")
def read_api_main():
    return {"status": "ok", "message": "API is running on /api/main"}

@app.post("/parse-pdf")
async def parse_pdf(file: UploadFile = File(...)):
    if not file.filename.lower().endswith('.pdf'):
        raise HTTPException(status_code=400, detail="El archivo debe ser un PDF")
        
    transactions = []
    temp_file = f"/tmp/temp_{file.filename}"
    
    try:
        # Guardar archivo temporal
        with open(temp_file, "wb") as f:
            content = await file.read()
            f.write(content)
            
        # Extraer texto con pdfplumber
        text = ""
        with pdfplumber.open(temp_file) as pdf:
            for page in pdf.pages:
                text += page.extract_text() + "\n"
                
        # Procesar línea por línea
        lines = text.split('\n')
        
        # Regex para línea de gasto normal
        # Ej: 20-FEB-2026 23-FEB-2026 MERPAGO*CANGREBURGUER CIUDAD DE MEX MX MAG 2105031W3 +$270.00
        single_line_re = re.compile(r"^(\d{2}-[A-Z]{3}-\d{4})\s+(\d{2}-[A-Z]{3}-\d{4})\s+(.+?)\s+([\+\-]\$[\d,]+\.\d{2})$")
        
        # Regex para inicio de línea múltiple (ej. pagos SPEI que toman varias líneas)
        # Ej: 10-MAR-2026 11-MAR-2026 HR LQ 19:59:08 PAGO TDC POR SPEI
        multi_start_re = re.compile(r"^(\d{2}-[A-Z]{3}-\d{4})\s+(\d{2}-[A-Z]{3}-\d{4})\s+(.+)$")
        
        # Regex para el monto que termina una línea múltiple
        # Ej: -$1,415.18
        end_amt_re = re.compile(r"^([\+\-]\$[\d,]+\.\d{2})$")
        
        current_multiline = None
        
        for line in lines:
            line = line.strip()
            if not line: continue
            
            # Intentar match de línea simple
            m = single_line_re.match(line)
            if m:
                op_date, charge_date, desc, amount_str = m.groups()
                
                # Solo nos importan los CARGOS (positivos +)
                if amount_str.startswith('+'):
                    amt = float(amount_str.replace('+$', '').replace(',', ''))
                    transactions.append({
                        "date": parse_banorte_date(op_date),
                        "description": desc.strip(),
                        "amount": amt
                    })
                current_multiline = None
                continue
                
            # Intentar match de inicio de multilínea
            ms = multi_start_re.match(line)
            if ms and not re.search(r"[\+\-]\$[\d,]+\.\d{2}$", line):
                op_date, charge_date, desc = ms.groups()
                current_multiline = {
                    "date": parse_banorte_date(op_date),
                    "description": desc.strip()
                }
                continue
                
            # Intentar match de fin de multilínea (solo un monto)
            me = end_amt_re.match(line)
            if me and current_multiline:
                amount_str = me.group(1)
                if amount_str.startswith('+'):
                    amt = float(amount_str.replace('+$', '').replace(',', ''))
                    transactions.append({
                        "date": current_multiline["date"],
                        "description": current_multiline["description"],
                        "amount": amt
                    })
                current_multiline = None
                continue
                
            # Opcional: si estamos dentro de multilínea, agregar texto a la descripción
            if current_multiline:
                # current_multiline["description"] += " " + line
                pass
                
        return {"transactions": transactions}
        
    finally:
        # Limpiar archivo temporal
        if os.path.exists(temp_file):
            os.remove(temp_file)

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
