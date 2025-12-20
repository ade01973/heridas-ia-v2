import { NextResponse } from 'next/server';
import OpenAI from 'openai';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { google } from 'googleapis';
import { Readable } from 'stream';

// --- CONFIGURACIÓN DE MENÚS EXACTOS + CUIDADOS ---
const SYSTEM_PROMPT_BASE = `
Actúa como enfermera experta en heridas. Analiza la imagen y devuelve un JSON.
Debes elegir la opción que mejor encaje de las listas EXACTAS para los campos de selección.

IMPORTANTE:
Se te proporcionará contexto del paciente (Edad, Diabetes, etc.). USA ESE CONTEXTO para personalizar el campo "recomendaciones_cuidados".

Listas EXACTAS:
- etiologia_probable: [
    "Lesión por presión (LPP)", 
    "Úlcera venosa (de extremidad inferior)", 
    "Úlcera arterial / isquémica", 
    "Úlcera de pie diabético (Neuropática/Neuroisquémica)", 
    "Herida quirúrgica (Dehiscencia o cierre por segunda intención)", 
    "Otro"
  ]
- tejido_predominante: [
    "Tejido necrótico", 
    "Tejido esfacelado", 
    "Tejido de granulación", 
    "Tejido de epitelización", 
    "Mezcla de tejidos (>50% sin predominio claro)"
  ]
- nivel_exudado: [
    "Seco / No visible", 
    "Húmedo óptimo", 
    "Mojado / saturado", 
    "Fuga de exudado"
  ]
- piel_perilesional: [
    "Sana / Intacta (Color y textura similar a la piel circundante normal)", 
    "Macerada (Color blanquecino, aspecto húmedo y frágil por exceso de exudado)", 
    "Eritematosa / Inflamada (Roja, con apariencia caliente o edematosa)", 
    "Hiperqueratósica / Callosa (Bordes engrosados, duros y secos)"
  ]
- signos_infeccion: [
    "No se observan signos de infección", 
    "Inflamación leve (eritema local)", 
    "Sospecha de infección local", 
    "Signos claros de infección local"
  ]
- aposito_primario: [
    "Ninguno (No aplicar pósito / Dejar al aire)", 
    "Hidrogel (Gel o placa)", 
    "Hidrocoloide", 
    "Espuma de poliuretano (Foam)", 
    "Alginato cálcico o Fibra gelificante (Hidrofibra)", 
    "Apósito con Plata u otro antimicrobiano (Yodo, DACC, Miel)", 
    "Malla de silicona o Tul graso (Interface neutra)"
  ]
- objetivo_aposito: [
    "Desbridar / Hidratar (Aportar humedad para ablandar necrosis seca; ej. Hidrogel)",
    "Gestionar exudado / Absorción (Controlar exceso de líquido; ej. Alginatos, Fibras, Espumas)",
    "Controlar carga bacteriana (Sospecha de infección local o biofilm; ej. Plata, DACC, Yodo)",
    "Proteger granulación / Epitelización (Mantener ambiente húmedo óptimo y evitar traumatismos)"
  ]

El campo "recomendaciones_cuidados" debe ser un texto breve (string) con saltos de línea o guiones.
Responde SOLO con el JSON válido.
`;

export async function POST(request: Request) {
  try {
    const { image, modelId, identificationCode, patientData } = await request.json();
    
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || '' });
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');

    if (!image) return NextResponse.json({ error: 'Falta imagen' }, { status: 400 });

    // Construimos el contexto
    const patientContext = `
      CONTEXTO DEL PACIENTE:
      - Edad: ${patientData?.edad || 'No especificada'}
      - Sexo: ${patientData?.sexo || 'No especificado'}
      - Patología Vascular: ${patientData?.vascular || 'No'}
      - Patología Cardiaca: ${patientData?.cardiaca || 'No'}
      - Diabético: ${patientData?.diabetico || 'No'}
    `;

    const FINAL_PROMPT = SYSTEM_PROMPT_BASE + "\n" + patientContext;
    let result = null;

    // 1. ANÁLISIS IA
    try {
      if (modelId === 'gemini') {
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
        const cleanBase64 = image.replace(/^data:image\/\w+;base64,/, "");
        const response = await model.generateContent([
          FINAL_PROMPT,
          { inlineData: { data: cleanBase64, mimeType: "image/jpeg" } }
        ]);
        const text = response.response.text().replace(/```json/g, '').replace(/```/g, '').trim();
        result = JSON.parse(text);
      } else {
        const response = await openai.chat.completions.create({
          model: "gpt-4o",
          messages: [
            { role: "system", content: FINAL_PROMPT },
            { role: "user", content: [{ type: "image_url", image_url: { url: image } }] },
          ],
          response_format: { type: "json_object" },
        });
        result = JSON.parse(response.choices[0].message.content || '{}');
      }
    } catch (aiError: any) {
      console.error("Error IA:", aiError);
      return NextResponse.json({ error: `Error en la IA: ${aiError.message}` }, { status: 500 });
    }

    // 2. SUBIR A DRIVE Y GUARDAR EN SHEET
    let sheetStatus = 'No configurado';
    let driveLink = 'No guardada';

    if (process.env.GOOGLE_SHEET_ID && process.env.GOOGLE_CLIENT_EMAIL && process.env.GOOGLE_PRIVATE_KEY) {
      try {
        const auth = new google.auth.GoogleAuth({
          credentials: {
            client_email: process.env.GOOGLE_CLIENT_EMAIL,
            private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
          },
          scopes: [
            'https://www.googleapis.com/auth/spreadsheets',
            'https://www.googleapis.com/auth/drive.file' 
          ],
        });

        // A) SUBIR FOTO A DRIVE (Si hay ID de carpeta configurada)
        if (process.env.GOOGLE_DRIVE_FOLDER_ID) {
          try {
            const drive = google.drive({ version: 'v3', auth });
            
            // Convertir Base64 a Stream
            const cleanBase64 = image.replace(/^data:image\/\w+;base64,/, "");
            const buffer = Buffer.from(cleanBase64, 'base64');
            const stream = new Readable();
            stream.push(buffer);
            stream.push(null);

            const fileMetadata = {
              name: `Herida_${identificationCode || 'SinID'}_${Date.now()}.jpg`,
              parents: [process.env.GOOGLE_DRIVE_FOLDER_ID],
            };
            
            const media = {
              mimeType: 'image/jpeg',
              body: stream,
            };

            const file = await drive.files.create({
              requestBody: fileMetadata,
              media: media,
              fields: 'id, webViewLink',
            });

            driveLink = file.data.webViewLink || 'Error Link';
            console.log("Foto subida a Drive:", driveLink);

          } catch (driveError: any) {
            console.error("Error subiendo a Drive:", driveError);
            driveLink = `Error Drive: ${driveError.message}`;
          }
        }

        // B) GUARDAR EN SHEET
        const sheets = google.sheets({ version: 'v4', auth });
        
        const row = [
          new Date().toLocaleString(),          // Col A
          identificationCode,                   // Col B
          result.etiologia_probable,            // Col C
          result.tejido_predominante,           // Col D
          result.nivel_exudado,                 // Col E
          result.signos_infeccion,              // Col F
          result.piel_perilesional,             // Col G
          result.objetivo_aposito,              // Col H
          result.aposito_primario,              // Col I
          "Inteligencia Artificial",            // Col J
          modelId === 'chatgpt' ? 'ChatGPT' : 'Gemini', // Col K
          "Versión v2.1 (Con Foto)",            // Col L
          driveLink                             // Col M (NUEVA: LINK FOTO)
        ];

        await sheets.spreadsheets.values.append({
          spreadsheetId: process.env.GOOGLE_SHEET_ID,
          range: 'Respuestas_IA!A:M', 
          valueInputOption: 'USER_ENTERED',
          insertDataOption: 'INSERT_ROWS',
          requestBody: { values: [row] },
        });
        sheetStatus = 'Guardado OK';
      } catch (e: any) {
        console.error("Error Sheet/Drive:", e);
        sheetStatus = `Fallo Google: ${e.message}`; 
      }
    }

    return NextResponse.json({ ...result, sheetStatus, driveLink });

  } catch (error: any) {
    console.error("Error General:", error);
    return NextResponse.json({ error: `Error Interno: ${error.message}` }, { status: 500 });
  }
}
