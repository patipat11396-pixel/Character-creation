"""Landmarks of each base body, measured on its source mesh.

All values are in the source's mesh space: centimetres, x to the character's
left, y back (front = -y), z up. process_character.py, face.py and the menu
(through the model's extras) read everything body-specific from here.
"""

BODIES = {
    "female": {
        "label": "Female",
        "src": "models/source/f_base.glb",
        "painted": "models/source/f_painted.glb",
        "out": "models/character_female.glb",
        # ---- hands (left hand; the right is mirrored)
        "hand_x": 44,                  # everything beyond this x is hand
        "wrist_x": 48,                 # finger weights are smoothed beyond this x
        "finger_y": {"Index": 3.9, "Middle": 6.8, "Ring": 9.4, "Pinky": 11.8},
        "knuckle_x": {"Index": 57.5, "Middle": 57.8, "Ring": 57.3, "Pinky": 56.5},
        "thumb_xy": [(50.5, 3.6), (54.0, 2.0), (56.5, 1.0)],   # base, knuckle, middle joint
        "thumb_max_y": 2.6,              # thumb tip search stays in front of the index finger
        # ---- body weight zones
        "hip_back_y": (2.6, 8.6),      # buttocks: behind the hip joint
        "pelvis_z": (70, 106),
        "shoulders_z": (100, 129),     # stops below the jaw
        "nipples": True,               # flattened by clean_body
        "breast_z": 111.0,
        # ---- face
        "nose_tip": (-7.45, 136.3),    # (y, z)
        "nose_width": 1.6,
        "mouth": {"z": 133.55, "kz": 0.045, "half": 3.1, "y": -5.95, "ky": 0.18,
                  "up": 0.75, "down": 0.95},     # lip heights above / below the line
        "chin_z": 129.5,
        "jaw_hinge": (3.5, 137.0),     # (y, z), in front of the ears
        "jaw_corner": (6.6, 2.5, 131.5),
        "brow_z": 146.5,
        "top_z": 158.25,
        "eye": {"x": 5.65, "z": 141.2, "w": 5.3, "h": 4.3},
        "iris": {"x": 4.9, "z": 141.2, "rx": 1.8, "rz": 2.1},     # on the painted texture
        "brow_box": [1.0, 144.3, 9.5, 146.9],                       # left brow: x0, z0, x1, z1
        "depth": 0.81,                 # head depth against the old reference head
    },
    "male": {
        "label": "Male",
        "src": "models/source/m_base.glb",
        "painted": "models/source/m_painted.glb",
        "out": "models/character_male.glb",
        "hand_x": 50,
        "wrist_x": 54,
        "finger_y": {"Index": -4.3, "Middle": -2.0, "Ring": 0.4, "Pinky": 2.6},
        "knuckle_x": {"Index": 61.5, "Middle": 62.0, "Ring": 61.5, "Pinky": 60.5},
        "thumb_xy": [(55.0, -4.0), (58.5, -6.3), (61.0, -7.3)],
        "thumb_max_y": -5.7,
        "hip_back_y": (-0.6, 5.4),
        "pelvis_z": (70, 106),
        "shoulders_z": (104, 143),

        "nose_tip": (-14.85, 152.0),
        "nose_width": 1.9,
        "mouth": {"z": 148.45, "kz": 0.0, "half": 3.6, "y": -12.8, "ky": 0.147,
                  "up": 0.75, "down": 1.0},
        "chin_z": 143.2,
        "jaw_hinge": (-3.5, 151.5),
        "jaw_corner": (7.4, -3.5, 146.0),
        "brow_z": 160.5,
        "top_z": 171.98,
        "eye": {"x": 5.4, "z": 156.4, "w": 5.2, "h": 3.8},
        "iris": {"x": 4.68, "z": 156.37, "rx": 1.15, "rz": 1.15},
        "brow_box": [1.0, 159.0, 9.5, 161.4],
        # The painted eyes' upper halves do not match the lower: repainted (build_skin.py).
        "eye_repaint": {"seam_z": 156.1, "opening": {"x": 4.85, "z": 156.25, "a": 2.45, "b": 1.85}},
        "depth": 0.82,
    },
}
